/**
 * 月間利用量チェックミドルウェア(法人番号 API 版)。
 *
 * プランごとの月間上限(canonical = plan-pricing.ts、2026-06-15 サインオフ = 住所クラス):
 * - Free 5,000 / Starter 200,000 / Pro 2,000,000 / Enterprise 無制限。
 *
 * 月間カウントは `usage-monthly:{customerId}:{YYYY-MM}` から読む(増分は usage-logger、
 * 6/29 wiring)。429 response は AI agent が 1 hop で paid 切替できるよう
 * `upgrade_url` / `pricing_url` / `next_plan` / `current_plan` を含む。
 *
 * さらに cross-API 利用者向けに `license_recommend`(Hub License = flat 月額の横断ライセンス)を
 * additive に提示する(per-request の `next_plan` と併存、AI は `X-Shirabe-Recommend` で 1 hop 判定)。
 *
 * ★ 現状(6/15)は scaffold: auth(API_KEYS 共有)未 wiring のため plan/customerId は未設定で
 *   pass-through、USAGE_LOGS 未 provisioning でも pass-through(本番は inert・挙動不変)。
 *   routes への適用 + auth + Stripe metering は 6/29 wiring(API_KEYS 共有判断後)。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "@/types";
import { isInternalEnrichRequest } from "@/util/internal-request";
import {
  NEXT_PLAN_MAP,
  PLAN_MONTHLY_LIMITS,
  PRICING_URL,
  UPGRADE_URL,
  secondsUntilMonthlyReset,
  type PlanName,
} from "@/middleware/plan-pricing";

/** プランごとの月間利用量上限(-1 = 無制限)。 */
export const MONTHLY_USAGE_LIMITS = PLAN_MONTHLY_LIMITS;

/** 確定済み Hub Pro 価格(価格 dial ¥40k/¥120k/¥280k の背骨、経営者確定)。 */
const HUB_PRO_MONTHLY_JPY = 120_000;

/** Hub License 横断ライセンスの cross-API 見積 endpoint。 */
const HUB_QUOTE_URL = "https://shirabe.dev/api/v1/pricing/quote?apis=corporation";

/**
 * 月間利用量カウントの KV キー(`usage-monthly:{customerId}:{YYYY-MM}`)。
 *
 * @param customerId - 顧客識別子。
 * @param now - 基準時刻(既定 = 現在)。
 */
export function getMonthlyUsageKey(customerId: string, now: Date = new Date()): string {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `usage-monthly:${customerId}:${ym}`;
}

/** 429 message を組み立てる。 */
function buildLimitMessage(plan: PlanName, limit: number): string {
  const label = plan.charAt(0).toUpperCase() + plan.slice(1);
  return `${label} plan limit (${limit.toLocaleString("en-US")} requests/month) reached. Upgrade to continue.`;
}

/**
 * 429 に additive 提示する Hub License 推奨ブロック(cross-API flat 月額)。
 *
 * ★ 現状は静的提示(corp を他 Shirabe API と横断利用する顧客向けの funnel)。
 *   利用 API 数に応じた条件判定(過剰提示回避)+ checkout/procurement URL は
 *   Hub wiring(6/29、API_KEYS 共有後)で calendar の licensing surface を再利用して拡張する。
 *   field 名は calendar の `license_recommend` と一致させ cross-API で AI が同形 parse 可能にする。
 */
function buildLicenseRecommend(): Record<string, unknown> {
  return {
    sku: "hub_pro",
    monthly_price_jpy: HUB_PRO_MONTHLY_JPY,
    reason:
      "Using corporation alongside other Shirabe APIs? Hub Pro is one flat monthly license across all APIs (single key, predictable cost).",
    quote_url: HUB_QUOTE_URL,
  };
}

/**
 * 月間上限ゲート。上限到達時は 429 + paid/Hub 導線を返す。
 *
 * pass-through 条件(本番 scaffold 安全):内部 enrich subrequest / plan|customerId 未設定
 * (auth 未 wiring)/ USAGE_LOGS 未 provisioning / Enterprise(無制限)。
 */
export async function usageCheckMiddleware(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  // 案 X: 正規の内部 enrich subrequest は非計上(上限ゲートを通さない)。
  if (isInternalEnrichRequest(c)) return next();

  const plan = c.get("plan") as PlanName | undefined;
  const customerId = c.get("customerId");
  if (!plan || !customerId) return next(); // auth 未 wiring

  const limit = MONTHLY_USAGE_LIMITS[plan];
  if (limit < 0) return next(); // Enterprise = 無制限

  const usageKV = c.env.USAGE_LOGS;
  if (!usageKV) return next(); // KV 未 provisioning(inert)

  const currentStr = await usageKV.get(getMonthlyUsageKey(customerId));
  const current = currentStr ? parseInt(currentStr, 10) : 0;
  if (current < limit) return next();

  const nextPlan = NEXT_PLAN_MAP[plan];
  const licenseRecommend = buildLicenseRecommend();
  c.header("Retry-After", String(secondsUntilMonthlyReset()));
  c.header("X-Shirabe-Recommend", String(licenseRecommend.sku));
  return c.json(
    {
      error: {
        code: "USAGE_LIMIT_EXCEEDED",
        message: buildLimitMessage(plan, limit),
        upgrade_url: UPGRADE_URL,
        pricing_url: PRICING_URL,
        current_plan: { name: plan, monthly_limit: limit, monthly_used: current },
        ...(nextPlan ? { next_plan: nextPlan } : {}),
        license_recommend: licenseRecommend,
      },
    },
    429
  );
}
