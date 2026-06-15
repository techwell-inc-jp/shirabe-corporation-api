import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import { usageCheckMiddleware, getMonthlyUsageKey } from "@/middleware/usage-check";

/** 任意キーに固定カウントを返す最小 KV モック。 */
function kvReturning(count: string | null) {
  return { get: async () => count } as unknown as KVNamespace;
}

/**
 * テスト用ハーネス: ヘッダから plan/customerId を context に流し込み、usage-check を適用する。
 * (本番の auth wiring の代役。auth 自体は 6/29 実装のため、ここでは値注入のみ。)
 */
function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const plan = c.req.header("X-Test-Plan");
    const cust = c.req.header("X-Test-Customer");
    if (plan) c.set("plan", plan as AppEnv["Variables"]["plan"]);
    if (cust) c.set("customerId", cust);
    await next();
  });
  app.use("*", usageCheckMiddleware);
  app.get("/x", (c) => c.json({ ok: true }));
  return app;
}

function req(headers: Record<string, string>, env: Record<string, unknown>) {
  return makeApp().request("/x", { headers }, env);
}

const BASE = { API_VERSION: "test", USAGE_LOGS: kvReturning("5000") };

describe("usageCheckMiddleware — pass-through(scaffold 安全)", () => {
  it("plan/customerId 未設定(auth 未 wiring)は通過", async () => {
    const res = await req({}, BASE);
    expect(res.status).toBe(200);
  });

  it("USAGE_LOGS 未 provisioning は通過", async () => {
    const res = await req(
      { "X-Test-Plan": "free", "X-Test-Customer": "anon_x" },
      { API_VERSION: "test" }
    );
    expect(res.status).toBe(200);
  });

  it("Enterprise(無制限)は count に関わらず通過", async () => {
    const res = await req(
      { "X-Test-Plan": "enterprise", "X-Test-Customer": "c1" },
      { API_VERSION: "test", USAGE_LOGS: kvReturning("9999999") }
    );
    expect(res.status).toBe(200);
  });

  it("上限未満は通過", async () => {
    const res = await req(
      { "X-Test-Plan": "free", "X-Test-Customer": "c1" },
      { API_VERSION: "test", USAGE_LOGS: kvReturning("100") }
    );
    expect(res.status).toBe(200);
  });
});

describe("usageCheckMiddleware — 上限到達で 429 + 導線", () => {
  it("Free 5,000 到達で 429、next_plan + license_recommend + ヘッダ", async () => {
    const res = await req(
      { "X-Test-Plan": "free", "X-Test-Customer": "c1" },
      { API_VERSION: "test", USAGE_LOGS: kvReturning("5000") }
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-Shirabe-Recommend")).toBe("hub_pro");

    const body = (await res.json()) as { error: Record<string, any> };
    expect(body.error.code).toBe("USAGE_LIMIT_EXCEEDED");
    expect(body.error.current_plan).toMatchObject({ name: "free", monthly_limit: 5000, monthly_used: 5000 });
    expect(body.error.next_plan.name).toBe("starter");
    expect(body.error.license_recommend.sku).toBe("hub_pro");
    expect(body.error.license_recommend.monthly_price_jpy).toBe(120000);
  });
});

describe("usageCheckMiddleware — 案 X 内部 enrich 非計上", () => {
  it("正規の X-Shirabe-Internal は上限超過でも通過", async () => {
    const res = await req(
      { "X-Test-Plan": "free", "X-Test-Customer": "c1", "X-Shirabe-Internal": "tok-123" },
      { API_VERSION: "test", USAGE_LOGS: kvReturning("5000"), INTERNAL_ENRICH_TOKEN: "tok-123" }
    );
    expect(res.status).toBe(200);
  });

  it("トークン不一致は通常どおり 429", async () => {
    const res = await req(
      { "X-Test-Plan": "free", "X-Test-Customer": "c1", "X-Shirabe-Internal": "wrong" },
      { API_VERSION: "test", USAGE_LOGS: kvReturning("5000"), INTERNAL_ENRICH_TOKEN: "tok-123" }
    );
    expect(res.status).toBe(429);
  });
});

describe("getMonthlyUsageKey", () => {
  it("usage-monthly:{customerId}:{YYYY-MM} 形式", () => {
    expect(getMonthlyUsageKey("anon_x", new Date(2026, 5, 15))).toBe("usage-monthly:anon_x:2026-06");
  });
});
