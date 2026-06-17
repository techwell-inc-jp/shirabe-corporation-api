/**
 * 利用量ログミドルウェア(法人番号 API 版)。
 *
 * metered route の処理後、成功レスポンス(2xx/3xx)のみ USAGE_LOGS KV に利用量を蓄積する。
 * calendar の `src/middleware/usage-logger.ts` を corporation 向けにミラーし、3 つのキーを増分する:
 *  - `usage:{customerId}:{YYYY-MM-DD}` — 日次カウント(Stripe 日次バッチ報告用、TTL 7 日)
 *  - `usage-monthly:{customerId}:{YYYY-MM}` — 月間カウント(usage-check が読む上限ゲート用、TTL 35 日)
 *  - `usage-index:{YYYY-MM-DD}` — 当日 active な customerId 一覧(Stripe バッチ列挙用、TTL 7 日)
 *
 * 月間キーは usage-check.ts の {@link getMonthlyUsageKey} を再利用し、読み手/書き手で
 * キー形式がドリフトしないことを保証する(単一の真実点)。
 *
 * 非計上(カウントしない)条件:
 *  - 案 X 内部 enrich subrequest(`isInternalEnrichRequest`)= usage-check と対称に非計上。
 *  - `customerId` 未設定(metered route 以外 = auth 未適用)。
 *  - `USAGE_LOGS` 未 binding(WS-2 前 = inert、本番挙動不変)。
 *  - 非 2xx/3xx レスポンス(エラーは課金しない)。
 *
 * ★ Stripe メーター報告は本ミドルウェアの責務外。日次バッチ reporter が `usage:` / `usage-index:`
 *   を消費してメーター送信する(6/29 wiring)。本ミドルウェアは KV 蓄積のみを担う。
 *
 * 規約: KV `expirationTtl` は最低 60 秒(親 §4)。本ファイルの TTL は全て 60 秒超で充足。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "@/types";
import { isInternalEnrichRequest } from "@/util/internal-request";
import { getMonthlyUsageKey } from "@/middleware/usage-check";

/** 日次カウント / 日付インデックスの TTL(7 日。日次バッチ処理後も参照余裕を持つ)。 */
const DAILY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 月間カウントの TTL(35 日。月をまたいでも参照可能)。 */
const MONTHLY_TTL_SECONDS = 35 * 24 * 60 * 60;

/** `YYYY-MM-DD` 文字列(calendar usage-logger と同一の桁揃え)。 */
function ymd(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 日次利用量カウントの KV キー(`usage:{customerId}:{YYYY-MM-DD}`)。
 *
 * @param customerId - 顧客識別子。
 * @param now - 基準時刻(既定 = 現在)。
 */
export function getDailyUsageKey(customerId: string, now: Date = new Date()): string {
  return `usage:${customerId}:${ymd(now)}`;
}

/**
 * 当日 active な customerId 一覧の KV キー(`usage-index:{YYYY-MM-DD}`)。
 *
 * @param now - 基準時刻(既定 = 現在)。
 */
export function getUsageIndexKey(now: Date = new Date()): string {
  return `usage-index:${ymd(now)}`;
}

/** 文字列カウントを整数化する(欠損/不正は 0)。 */
function toCount(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * 利用量ログミドルウェア。`next()` 後に成功レスポンスのみ KV 蓄積する。
 *
 * 計上は executionCtx.waitUntil でレスポンスをブロックせずに行う
 * (executionCtx が無いテスト環境では同期的に await する)。
 */
export async function usageLoggerMiddleware(c: Context<AppEnv>, next: Next): Promise<void> {
  await next();

  // エラーレスポンスは計上しない。
  if (c.res.status < 200 || c.res.status >= 400) return;
  // 案 X 内部 enrich subrequest は非計上(usage-check と対称)。
  if (isInternalEnrichRequest(c)) return;

  const customerId = c.get("customerId");
  if (!customerId) return; // auth 未適用ルート

  const usageKV = c.env.USAGE_LOGS;
  if (!usageKV) return; // 未 provisioning = inert(本番挙動不変)

  const recordUsage = async (): Promise<void> => {
    const now = new Date();

    // 日次カウント。
    const dailyKey = getDailyUsageKey(customerId, now);
    const daily = toCount(await usageKV.get(dailyKey));
    await usageKV.put(dailyKey, String(daily + 1), { expirationTtl: DAILY_TTL_SECONDS });

    // 月間カウント(usage-check が読む)。キー形式は usage-check と共有。
    const monthlyKey = getMonthlyUsageKey(customerId, now);
    const monthly = toCount(await usageKV.get(monthlyKey));
    await usageKV.put(monthlyKey, String(monthly + 1), { expirationTtl: MONTHLY_TTL_SECONDS });

    // 当日 active customerId インデックス(Stripe 日次バッチ列挙用)。
    const indexKey = getUsageIndexKey(now);
    const indexStr = await usageKV.get(indexKey);
    const ids = indexStr ? new Set(indexStr.split(",")) : new Set<string>();
    if (!ids.has(customerId)) {
      ids.add(customerId);
      await usageKV.put(indexKey, Array.from(ids).join(","), { expirationTtl: DAILY_TTL_SECONDS });
    }
  };

  try {
    const ctx = c.executionCtx;
    if (ctx && "waitUntil" in ctx) {
      ctx.waitUntil(recordUsage());
    } else {
      await recordUsage();
    }
  } catch {
    // executionCtx 不在(テスト等)→ 同期的に計上。
    await recordUsage();
  }
}
