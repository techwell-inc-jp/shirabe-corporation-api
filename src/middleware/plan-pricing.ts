/**
 * プラン別料金 / 上限情報と「次のプラン」マップ(法人番号 API 版)。
 *
 * AI agent が 429 response から 1 hop で「次に upgrade すべきプラン名 / 料金 /
 * checkout URL」を取得できるようにする(paid 突破経路 ergonomics、暦/住所と同形)。
 *
 * ★ 価格 dial = 住所クラス(B2B identifier、2026-06-15 経営者サインオフ):
 *   Free 5,000 / Starter 200,000(¥0.5)/ Pro 2,000,000(¥0.3)/ Enterprise ∞(¥0.1)。
 *   根拠: corp と住所は B2B identifier ペアで価値ベース価格を対称化(Hub バンドル整合)。
 *   単価の微調整は 6/30・9/30 の実測 evidence を見てから(現状は住所ミラー)。
 */

export type PlanName = "free" | "starter" | "pro" | "enterprise";

export type CurrentPlanSummary = {
  name: PlanName;
  monthly_limit: number; // -1 = 無制限
  monthly_used: number;
};

export type NextPlanSummary = {
  name: PlanName;
  monthly_limit: number; // -1 = 無制限
  price_per_request_jpy: number;
  monthly_price_example_jpy: number;
  example_monthly_requests: number;
  checkout_path: string;
};

export const PRICING_URL = "https://shirabe.dev/docs/corporation-pricing";
export const UPGRADE_URL = "https://shirabe.dev/upgrade";

/**
 * プラン別の月間上限(canonical、2026-06-15 サインオフ = 住所クラス)。
 * usage-check.ts はこの map を single source of truth として参照する。
 */
export const PLAN_MONTHLY_LIMITS: Record<PlanName, number> = {
  free: 5_000,
  starter: 200_000,
  pro: 2_000_000,
  enterprise: -1,
} as const;

/**
 * 次のプラン map(現プランから upgrade した場合の説明)。
 * Enterprise には next_plan なし。単価/例示は住所クラス(暦の 10 倍)。
 */
export const NEXT_PLAN_MAP: Partial<Record<PlanName, NextPlanSummary>> = {
  free: {
    name: "starter",
    monthly_limit: 200_000,
    price_per_request_jpy: 0.5,
    monthly_price_example_jpy: 100_000,
    example_monthly_requests: 200_000,
    checkout_path: "/upgrade?plan=starter&api=corporation&from=429",
  },
  starter: {
    name: "pro",
    monthly_limit: 2_000_000,
    price_per_request_jpy: 0.3,
    monthly_price_example_jpy: 600_000,
    example_monthly_requests: 2_000_000,
    checkout_path: "/upgrade?plan=pro&api=corporation&from=429",
  },
  pro: {
    name: "enterprise",
    monthly_limit: -1,
    price_per_request_jpy: 0.1,
    monthly_price_example_jpy: 1_000_000,
    example_monthly_requests: 10_000_000,
    checkout_path: "/upgrade?plan=enterprise&api=corporation&from=429",
  },
} as const;

/**
 * 翌月 1 日 0 時(月次 reset 時刻)を返す。
 *
 * @param now - 基準時刻(既定 = 現在)。
 * @returns 次の月初。
 */
export function getMonthlyResetDate(now: Date = new Date()): Date {
  const year = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const month = now.getMonth() === 11 ? 0 : now.getMonth() + 1;
  return new Date(year, month, 1);
}

/**
 * 月次 reset までの残秒数(`Retry-After` header 用)。
 *
 * @param now - 基準時刻(既定 = 現在)。
 * @returns 残秒数(>=0)。
 */
export function secondsUntilMonthlyReset(now: Date = new Date()): number {
  const reset = getMonthlyResetDate(now);
  return Math.max(0, Math.ceil((reset.getTime() - now.getTime()) / 1000));
}
