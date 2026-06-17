import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import {
  usageLoggerMiddleware,
  getDailyUsageKey,
  getUsageIndexKey,
} from "@/middleware/usage-logger";
import { getMonthlyUsageKey } from "@/middleware/usage-check";

/** get/put を保持する最小 stateful KV モック。 */
function statefulKV() {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

/**
 * テスト用ハーネス: ヘッダから customerId を context に流し込み(auth の代役)、
 * usage-logger を適用する。/ok=200、/bad=400 のハンドラを用意。
 * executionCtx は渡さないため、logger は同期的に計上する(catch 分岐)。
 */
function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const cust = c.req.header("X-Test-Customer");
    if (cust) c.set("customerId", cust);
    await next();
  });
  app.use("*", usageLoggerMiddleware);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/bad", (c) => c.json({ error: { code: "X", message: "x" } }, 400));
  return app;
}

function call(
  path: string,
  headers: Record<string, string>,
  env: Record<string, unknown>
) {
  return makeApp().request(path, { headers }, env);
}

describe("usageLoggerMiddleware — 成功レスポンスを計上", () => {
  it("200 で daily / monthly / index を +1 する", async () => {
    const { kv, store } = statefulKV();
    const res = await call("/ok", { "X-Test-Customer": "c1" }, { API_VERSION: "test", USAGE_LOGS: kv });
    expect(res.status).toBe(200);

    expect(store.get(getDailyUsageKey("c1"))).toBe("1");
    expect(store.get(getMonthlyUsageKey("c1"))).toBe("1");
    expect(store.get(getUsageIndexKey())?.split(",")).toContain("c1");
  });

  it("複数回呼ぶと daily / monthly が累積する(index は重複しない)", async () => {
    const { kv, store } = statefulKV();
    for (let i = 0; i < 3; i++) {
      await call("/ok", { "X-Test-Customer": "c1" }, { API_VERSION: "test", USAGE_LOGS: kv });
    }
    expect(store.get(getDailyUsageKey("c1"))).toBe("3");
    expect(store.get(getMonthlyUsageKey("c1"))).toBe("3");
    expect(store.get(getUsageIndexKey())).toBe("c1");
  });

  it("複数 customer は index に併記される", async () => {
    const { kv, store } = statefulKV();
    await call("/ok", { "X-Test-Customer": "c1" }, { API_VERSION: "test", USAGE_LOGS: kv });
    await call("/ok", { "X-Test-Customer": "c2" }, { API_VERSION: "test", USAGE_LOGS: kv });
    const ids = store.get(getUsageIndexKey())?.split(",");
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
  });
});

describe("usageLoggerMiddleware — 非計上(inert / 安全)", () => {
  it("USAGE_LOGS 未 binding は no-op で 200(inert)", async () => {
    const res = await call("/ok", { "X-Test-Customer": "c1" }, { API_VERSION: "test" });
    expect(res.status).toBe(200);
  });

  it("customerId 未設定(auth 未適用)は計上しない", async () => {
    const { kv, store } = statefulKV();
    const res = await call("/ok", {}, { API_VERSION: "test", USAGE_LOGS: kv });
    expect(res.status).toBe(200);
    expect(store.size).toBe(0);
  });

  it("非 2xx/3xx(400)は計上しない", async () => {
    const { kv, store } = statefulKV();
    const res = await call("/bad", { "X-Test-Customer": "c1" }, { API_VERSION: "test", USAGE_LOGS: kv });
    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("案 X 内部 enrich(正規 X-Shirabe-Internal)は非計上", async () => {
    const { kv, store } = statefulKV();
    const res = await call(
      "/ok",
      { "X-Test-Customer": "c1", "X-Shirabe-Internal": "tok-123" },
      { API_VERSION: "test", USAGE_LOGS: kv, INTERNAL_ENRICH_TOKEN: "tok-123" }
    );
    expect(res.status).toBe(200);
    expect(store.size).toBe(0);
  });

  it("X-Shirabe-Internal 不一致は通常どおり計上", async () => {
    const { kv, store } = statefulKV();
    await call(
      "/ok",
      { "X-Test-Customer": "c1", "X-Shirabe-Internal": "wrong" },
      { API_VERSION: "test", USAGE_LOGS: kv, INTERNAL_ENRICH_TOKEN: "tok-123" }
    );
    expect(store.get(getMonthlyUsageKey("c1"))).toBe("1");
  });
});

describe("usage-logger キー形式", () => {
  it("getDailyUsageKey = usage:{customerId}:{YYYY-MM-DD}", () => {
    expect(getDailyUsageKey("anon_x", new Date(2026, 5, 17))).toBe("usage:anon_x:2026-06-17");
  });

  it("getUsageIndexKey = usage-index:{YYYY-MM-DD}", () => {
    expect(getUsageIndexKey(new Date(2026, 5, 17))).toBe("usage-index:2026-06-17");
  });

  it("月間キーは usage-check と同一形式(再利用でドリフトしない)", () => {
    expect(getMonthlyUsageKey("anon_x", new Date(2026, 5, 17))).toBe("usage-monthly:anon_x:2026-06");
  });
});
