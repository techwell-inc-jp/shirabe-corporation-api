/**
 * Stripe 日次利用量レポート（法人番号 API 版、GitHub Actions 用スタンドアロンスクリプト）
 *
 * corp の usage-logger が Cloudflare KV (USAGE_LOGS = corp 専用 namespace) に蓄積した
 * 日次利用量を Cloudflare REST API 経由で取得し、Stripe Billing Meter Events API に送信する。
 * calendar の `scripts/stripe-daily-report.ts` を corp 向けにミラーし、以下 1 点のみ差し替える:
 *
 *  - **メーターイベント名 = `corporation_api_requests`**(corp 専用メーター)。
 *    corp の従量単価(¥0.5/0.3/0.1、住所クラス)は calendar(¥0.05/0.03/0.01)の 10 倍であり、
 *    同一メーターに混在させると価格が破綻する。Stripe 側で corp 専用メーター + corp metered
 *    Price を作成し、その event_name を本スクリプトに合わせる(既定値は下記、env で上書き可)。
 *
 * usage / customer-map とも **corp 自身の USAGE_LOGS namespace**(`94f92f2a…`)から読む。
 * corp は他 API と同様に自前 checkout + webhook を持ち、per-request key 発行時に webhook が
 * `stripe:customer-map` を corp 自 namespace に書く(calendar と同じ単一 namespace 方式)。
 *
 * 必要な環境変数:
 *   - STRIPE_SECRET_KEY            : Stripe Secret Key (sk_live_* / sk_test_*)
 *   - CLOUDFLARE_API_TOKEN         : corp USAGE_LOGS の Read 権限を持つ API Token
 *   - CLOUDFLARE_ACCOUNT_ID        : Cloudflare Account ID
 *
 * 任意の環境変数:
 *   - REPORT_DATE                  : 対象日 (YYYY-MM-DD)、未指定時は UTC 前日
 *   - USAGE_KV_NAMESPACE_ID        : corp USAGE_LOGS の namespace ID（既定: corp 専用 = 下記)
 *   - CUSTOMER_MAP_NAMESPACE_ID    : customer-map の namespace ID（既定: usage と同一 = corp 自 namespace)
 *   - CUSTOMER_MAP_KEY             : customer-map の KV キー名（既定: "stripe:customer-map"）
 *   - METER_EVENT_NAME             : corp 専用メーターのイベント名（既定: "corporation_api_requests"）
 *
 * Node.js 20+ の global fetch を使用し src/ からの import は行わないため、
 * CI 環境でのモジュール解決問題（ERR_MODULE_NOT_FOUND）を回避する。
 *
 * ── 終了コードの原則(calendar と同一) ─────────────────────────────────
 * 「マッピング未登録 = 失敗」ではない。匿名 Free ユーザー(`anon_*`)は Stripe 契約が
 * 無いのが正常、flat Hub license 保持者(license-checkout は customer-map を書かない)も
 * 未登録のままが正常、解約済顧客(`cust_*`)も恒常的にマッピングから消えるのが正常。
 * これらを failed 扱いにすると AI の匿名利用が増えるほど毎日ワークフローが赤くなり、
 * 絶対ルール1「AI が使う前提」と矛盾する。
 *
 * したがって exit 1 は以下の場合のみ:
 *   - Stripe Meter Events API が実際にエラーを返した
 *   - 必須環境変数が未設定
 *   - KV/顧客マップ読み込みの致命的失敗
 *
 * `anon_*` / マッピング無し(flat license・解約済)は INFO/WARN ログで skip する。
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** corp 専用 USAGE_LOGS namespace（wrangler.toml の USAGE_LOGS と同一 = usage / customer-map 共通)。 */
const DEFAULT_USAGE_KV_NAMESPACE_ID = "94f92f2a3f3f4bf8b3c42de8e9ff1715";
/** customer-map も corp 自 namespace に保持(corp webhook が書く、calendar と同じ単一 namespace 方式)。 */
const DEFAULT_CUSTOMER_MAP_NAMESPACE_ID = DEFAULT_USAGE_KV_NAMESPACE_ID;
const DEFAULT_CUSTOMER_MAP_KEY = "stripe:customer-map";
/** corp 専用メーターのイベント名（calendar の "api_requests" とは別系列、価格 10 倍差のため）。 */
const DEFAULT_METER_EVENT_NAME = "corporation_api_requests";

/** 匿名ユーザーの customerId プレフィックス */
const ANONYMOUS_PREFIX = "anon_";

export type UsageEntry = { customerId: string; count: number };
export type CustomerStripeMap = Record<string, { stripeCustomerId: string }>;

/**
 * 1件の処理結果ステータス。
 * - `reported`          : Stripe Meter Events にレポート成功
 * - `skipped_anonymous` : `anon_*` で Stripe 契約なし → 正常スキップ
 * - `skipped_unmapped`  : 顧客マップに未登録(flat license / 解約済等)→ 正常スキップ
 * - `stripe_error`      : Stripe API が実際にエラーを返した(真の失敗、exit 1対象)
 */
export type ReportStatus =
  | "reported"
  | "skipped_anonymous"
  | "skipped_unmapped"
  | "stripe_error";

export type ReportResult = {
  customerId: string;
  count: number;
  status: ReportStatus;
  error?: string;
};

/** 必須環境変数を取得、未設定ならエラーで終了する。*/
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[ERROR] Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

/** UTC で前日の日付 (YYYY-MM-DD) を返す。*/
export function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Cloudflare KV REST API から値を取得する。
 * 404 の場合は null を返す。
 */
export async function kvGet(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  key: string
): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(
    key
  )}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KV GET failed (${res.status}) for key="${key}": ${body}`);
  }
  return await res.text();
}

/** 指定日の利用量を KV から集計する。*/
export async function collectDailyUsage(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  date: string
): Promise<UsageEntry[]> {
  const indexStr = await kvGet(
    accountId,
    namespaceId,
    apiToken,
    `usage-index:${date}`
  );
  if (!indexStr) return [];

  const customerIds = indexStr.split(",").filter(Boolean);
  const entries: UsageEntry[] = [];
  for (const customerId of customerIds) {
    const countStr = await kvGet(
      accountId,
      namespaceId,
      apiToken,
      `usage:${customerId}:${date}`
    );
    const count = countStr ? parseInt(countStr, 10) : 0;
    if (count > 0) entries.push({ customerId, count });
  }
  return entries;
}

/**
 * Stripe Billing Meter Events API に利用量を送信する。
 */
export async function reportToStripe(
  stripeSecretKey: string,
  stripeCustomerId: string,
  eventName: string,
  quantity: number,
  timestamp: number
): Promise<{ success: boolean; error?: string }> {
  const url = "https://api.stripe.com/v1/billing/meter_events";
  const body = new URLSearchParams({
    event_name: eventName,
    "payload[value]": String(quantity),
    "payload[stripe_customer_id]": stripeCustomerId,
    timestamp: String(timestamp),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text();
    return {
      success: false,
      error: `Stripe API error ${res.status}: ${errBody}`,
    };
  }
  return { success: true };
}

/**
 * エントリ群を分類し、必要なものだけ Stripe に報告する(純粋処理、テスト可能)。
 *
 * @param deps.reportToStripe Stripe 送信関数(テストでは差し替え可)
 * @returns 各エントリの処理結果(status 付き)
 */
export async function processEntries(
  entries: UsageEntry[],
  customerMap: CustomerStripeMap,
  stripeSecretKey: string,
  meterEventName: string,
  timestamp: number,
  deps: {
    reportToStripe: typeof reportToStripe;
  } = { reportToStripe }
): Promise<ReportResult[]> {
  const results: ReportResult[] = [];

  for (const entry of entries) {
    // 匿名 Free ユーザーは Stripe 契約がないため、正常スキップ
    if (entry.customerId.startsWith(ANONYMOUS_PREFIX)) {
      results.push({
        customerId: entry.customerId,
        count: entry.count,
        status: "skipped_anonymous",
      });
      continue;
    }

    const mapping = customerMap[entry.customerId];
    // マッピング未登録 = flat license / 解約済 / 初回投入前 → 警告扱い、失敗ではない
    if (!mapping) {
      results.push({
        customerId: entry.customerId,
        count: entry.count,
        status: "skipped_unmapped",
      });
      continue;
    }

    // 実際の Stripe 送信
    const r = await deps.reportToStripe(
      stripeSecretKey,
      mapping.stripeCustomerId,
      meterEventName,
      entry.count,
      timestamp
    );

    if (r.success) {
      results.push({
        customerId: entry.customerId,
        count: entry.count,
        status: "reported",
      });
    } else {
      results.push({
        customerId: entry.customerId,
        count: entry.count,
        status: "stripe_error",
        error: r.error,
      });
    }
  }

  return results;
}

/**
 * 集計結果をログ出力し、終了コードを決定する(純粋処理)。
 *
 * 終了コードの決定ルール:
 *   - Stripe API が実際に失敗したものが1件でもあれば 1
 *   - それ以外(success のみ、skipped のみ、entries 0) は 0
 */
export function summarizeAndDecideExitCode(
  results: ReportResult[],
  logger: { log: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void } = console
): number {
  const reported = results.filter((r) => r.status === "reported");
  const skippedAnon = results.filter((r) => r.status === "skipped_anonymous");
  const skippedUnmapped = results.filter((r) => r.status === "skipped_unmapped");
  const stripeErrors = results.filter((r) => r.status === "stripe_error");

  logger.log(
    `[INFO] Reported ${reported.length}/${results.length} to Stripe`
  );

  if (skippedAnon.length > 0) {
    const totalCalls = skippedAnon.reduce((sum, r) => sum + r.count, 0);
    logger.log(
      `[INFO] Skipped ${skippedAnon.length} anonymous entries (total ${totalCalls} calls) — expected for anon_* users, no Stripe contract`
    );
  }

  for (const r of skippedUnmapped) {
    logger.warn(
      `[WARN] No Stripe mapping for ${r.customerId}, skipping (flat license or cancelled) count=${r.count}`
    );
  }

  for (const r of stripeErrors) {
    logger.error(
      `[ERROR] customer=${r.customerId} count=${r.count} error=${r.error}`
    );
  }

  return stripeErrors.length > 0 ? 1 : 0;
}

/**
 * main エントリポイント。終了コードを返す(process.exit は呼ばない)。
 *
 * テスト都合で分離: CLI から起動する場合はファイル末尾のガード付き
 * ブロックがこれを呼び、返り値を process.exit に渡す。
 */
export async function main(): Promise<number> {
  const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
  const cfApiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const cfAccountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");

  const usageNamespaceId =
    process.env.USAGE_KV_NAMESPACE_ID ?? DEFAULT_USAGE_KV_NAMESPACE_ID;
  const customerMapNamespaceId =
    process.env.CUSTOMER_MAP_NAMESPACE_ID ?? DEFAULT_CUSTOMER_MAP_NAMESPACE_ID;
  const customerMapKey =
    process.env.CUSTOMER_MAP_KEY ?? DEFAULT_CUSTOMER_MAP_KEY;
  const meterEventName =
    process.env.METER_EVENT_NAME ?? DEFAULT_METER_EVENT_NAME;
  const date = process.env.REPORT_DATE ?? yesterdayUTC();

  console.log(`[INFO] Stripe daily report (corporation) for ${date}`);
  console.log(`[INFO] Usage KV namespace: ${usageNamespaceId}`);
  console.log(`[INFO] Customer-map KV namespace: ${customerMapNamespaceId}`);
  console.log(`[INFO] Meter event name: ${meterEventName}`);

  // 顧客 → StripeCustomerID マッピングを calendar namespace から取得
  const mapStr = await kvGet(
    cfAccountId,
    customerMapNamespaceId,
    cfApiToken,
    customerMapKey
  );

  let customerMap: CustomerStripeMap = {};
  if (!mapStr) {
    console.log(
      `[WARN] No customer map at KV key "${customerMapKey}". All non-anonymous entries will be skipped.`
    );
  } else {
    try {
      customerMap = JSON.parse(mapStr) as CustomerStripeMap;
    } catch (e) {
      console.error(
        `[ERROR] Failed to parse customer map JSON from KV: ${
          (e as Error).message
        }`
      );
      return 1;
    }
  }

  const entries = await collectDailyUsage(
    cfAccountId,
    usageNamespaceId,
    cfApiToken,
    date
  );
  console.log(`[INFO] Found usage for ${entries.length} customer(s)`);

  if (entries.length === 0) return 0;

  const timestamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const results = await processEntries(
    entries,
    customerMap,
    stripeSecretKey,
    meterEventName,
    timestamp
  );

  return summarizeAndDecideExitCode(results);
}

// ---------------------------------------------------------------------------
// エントリポイントガード
// ---------------------------------------------------------------------------
// 直接実行(`npx tsx scripts/stripe-daily-report.ts`)のときだけ main() を回す。
// 単体テストから import された際に main() が勝手に走るのを防ぐ。
// Windows/Linux 両対応のためパスは `resolve()` で正規化してから比較する。
// ---------------------------------------------------------------------------
function isInvokedDirectly(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    const invoked = resolve(arg);
    const thisFile = resolve(fileURLToPath(import.meta.url));
    return invoked === thisFile;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[FATAL] ${(err as Error).stack ?? String(err)}`);
      process.exit(1);
    });
}
