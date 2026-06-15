import { describe, it, expect } from "vitest";
import {
  PLAN_MONTHLY_LIMITS,
  NEXT_PLAN_MAP,
  getMonthlyResetDate,
  secondsUntilMonthlyReset,
} from "@/middleware/plan-pricing";

describe("PLAN_MONTHLY_LIMITS(2026-06-15 サインオフ = 住所クラス)", () => {
  it("Free 5,000 / Starter 200k / Pro 2M / Enterprise 無制限", () => {
    expect(PLAN_MONTHLY_LIMITS.free).toBe(5_000);
    expect(PLAN_MONTHLY_LIMITS.starter).toBe(200_000);
    expect(PLAN_MONTHLY_LIMITS.pro).toBe(2_000_000);
    expect(PLAN_MONTHLY_LIMITS.enterprise).toBe(-1);
  });
});

describe("NEXT_PLAN_MAP", () => {
  it("free → starter(¥0.5 / 200k / api=corporation)", () => {
    const next = NEXT_PLAN_MAP.free!;
    expect(next.name).toBe("starter");
    expect(next.price_per_request_jpy).toBe(0.5);
    expect(next.monthly_limit).toBe(200_000);
    expect(next.checkout_path).toContain("api=corporation");
  });

  it("pro → enterprise(¥0.1 / 無制限)", () => {
    const next = NEXT_PLAN_MAP.pro!;
    expect(next.name).toBe("enterprise");
    expect(next.price_per_request_jpy).toBe(0.1);
    expect(next.monthly_limit).toBe(-1);
  });

  it("enterprise には next_plan なし", () => {
    expect(NEXT_PLAN_MAP.enterprise).toBeUndefined();
  });
});

describe("getMonthlyResetDate", () => {
  it("月内の日付は翌月 1 日を返す", () => {
    const reset = getMonthlyResetDate(new Date(2026, 5, 15)); // 6/15
    expect(reset.getFullYear()).toBe(2026);
    expect(reset.getMonth()).toBe(6); // July
    expect(reset.getDate()).toBe(1);
  });

  it("12 月は翌年 1 月へ繰り上がる", () => {
    const reset = getMonthlyResetDate(new Date(2026, 11, 20)); // 12/20
    expect(reset.getFullYear()).toBe(2027);
    expect(reset.getMonth()).toBe(0);
  });
});

describe("secondsUntilMonthlyReset", () => {
  it("非負の残秒数を返す", () => {
    expect(secondsUntilMonthlyReset(new Date(2026, 5, 15))).toBeGreaterThan(0);
  });
});
