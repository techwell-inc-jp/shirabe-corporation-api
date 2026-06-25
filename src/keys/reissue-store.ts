/**
 * self-serve キー再発行の KV ロジック(トークン管理 + per-request キー回転)
 *
 * 法人番号 API は per-request キーのみを再発行対象とする(Hub License の発行は calendar に
 * 集約されるため、corp での再発行対象は per-request キーに限る)。住所 API の
 * reissue-store.ts を corp 用に移植したもの(license 部分は含まない)。
 *
 * 設計:
 *  - キーは決済直後の success ページで一度しか表示されず、平文は長期保存しない。
 *    紛失時は「再発行(rotate)」= 新キー発行 + 旧キー失効。
 *  - メール所有検証の2段階フロー(なりすまし防止)。
 *  - customerId は据え置き(キー + ハッシュのみ回転)。
 *  - email 起点の逆引きは webhook が書く `email:{email}` → apiKeyHash 索引を使う。
 *
 * KV namespace:
 *  - API_KEYS  : 暦/住所/text と共有の集約 namespace(per-request key の `{sha256hex}`)
 *  - USAGE_LOGS: corp 専用 namespace(`email:` 索引・`stripe-reverse:`・再発行トークン)
 */
import { sha256Hex } from "../util/sha256.js";

/** per-request key 索引の prefix(webhook が書く `email:{email}` → apiKeyHash)。 */
export const EMAIL_INDEX_PREFIX = "email:";
/** Stripe customer → per-request 逆引きの prefix(webhook と共通)。 */
export const STRIPE_REVERSE_PREFIX = "stripe-reverse:";
/** 再発行ワンタイムトークン(hash)の prefix。 */
export const REISSUE_TOKEN_PREFIX = "reissue-token:";
/** トークン TTL(30分 = 1800秒)。KV 最低 60 秒制約は満たす。 */
export const REISSUE_TOKEN_TTL = 1800;

/** APIキーに使うランダム英数字の文字セット(routes/checkout.ts と同一)。 */
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** ワンタイムトークンに紐づく再発行対象レコード(USAGE_LOGS に保存)。 */
export interface ReissueTokenRecord {
  /** 旧 apiKeyHash(回転対象)。 */
  ref: string;
  /** 索引更新と通知に使う登録メール。 */
  email: string;
  /** 発行時刻(ISO8601)。 */
  createdAt: string;
}

/**
 * shrb_ + 32文字ランダム英数字 の per-request API キーを生成する。
 * ※ フォーマットは routes/checkout.ts の generateApiKey と一致させること
 *    (auth の `^shrb_[a-zA-Z0-9]{32}$` で検証される)。
 */
export function generatePerRequestKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let key = "shrb_";
  for (let i = 0; i < 32; i++) {
    const idx = bytes[i] as number;
    key += CHARSET[idx % CHARSET.length];
  }
  return key;
}

/** 64 hex のワンタイムトークンを生成する(URL に載せる平文、保存は hash)。 */
export function generateReissueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * email から再発行対象(apiKeyHash)を解決する。`email:` 索引は有償契約の
 * checkout 完了時にのみ書かれるため、存在 = 有償顧客(plan 再判定は不要)。
 *
 * @returns apiKeyHash または null(該当なし)
 */
export async function resolveReissueTarget(
  usageLogs: KVNamespace,
  email: string
): Promise<string | null> {
  return usageLogs.get(`${EMAIL_INDEX_PREFIX}${email}`);
}

/** トークンを保存する(平文トークンの SHA-256 を key にする)。 */
export async function putReissueToken(
  usageLogs: KVNamespace,
  token: string,
  record: ReissueTokenRecord
): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await usageLogs.put(`${REISSUE_TOKEN_PREFIX}${tokenHash}`, JSON.stringify(record), {
    expirationTtl: Math.max(60, REISSUE_TOKEN_TTL),
  });
}

/**
 * トークンを検証して消費する(single-use: 読めたら即削除)。
 * 削除を回転より前に行い、二重クリック / リンク再訪での二重回転を防ぐ。
 *
 * @returns 紐づくレコード、または null(未発行 / 失効 / 不正)
 */
export async function consumeReissueToken(
  usageLogs: KVNamespace,
  token: string
): Promise<ReissueTokenRecord | null> {
  const tokenHash = await sha256Hex(token);
  const key = `${REISSUE_TOKEN_PREFIX}${tokenHash}`;
  const raw = await usageLogs.get(key);
  if (!raw) return null;
  await usageLogs.delete(key);
  try {
    return JSON.parse(raw) as ReissueTokenRecord;
  } catch {
    return null;
  }
}

/**
 * per-request key を回転する。新しい平文キーを返す。対象が消えていれば null。
 *
 * - 既存レコード(aggregated、customerId・stripeCustomerId を top-level に持つ)を
 *   そのまま新ハッシュへ移植(customerId 据え置き)。
 * - 旧ハッシュを削除(旧キー失効)。
 * - `email:` 索引と `stripe-reverse:` を新ハッシュへ更新。
 */
export async function rotatePerRequestKey(
  apiKeys: KVNamespace,
  usageLogs: KVNamespace,
  oldHash: string,
  email: string
): Promise<string | null> {
  const recordStr = await apiKeys.get(oldHash);
  if (!recordStr) return null;

  let stripeCustomerId: string | undefined;
  let customerId: string | undefined;
  try {
    const parsed = JSON.parse(recordStr) as {
      stripeCustomerId?: string;
      customerId?: string;
    };
    stripeCustomerId = parsed.stripeCustomerId;
    customerId = parsed.customerId;
  } catch {
    // 破損レコードでも回転は続行(索引整合を優先)。
  }

  const newKey = generatePerRequestKey();
  const newHash = await sha256Hex(newKey);

  await apiKeys.put(newHash, recordStr);
  await apiKeys.delete(oldHash);
  await usageLogs.put(`${EMAIL_INDEX_PREFIX}${email}`, newHash);
  if (stripeCustomerId && customerId) {
    await usageLogs.put(
      `${STRIPE_REVERSE_PREFIX}${stripeCustomerId}`,
      `${customerId},${newHash}`
    );
  }
  return newKey;
}
