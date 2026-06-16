import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import { authMiddleware, getAnonymousId } from "@/middleware/auth";
import type { Context } from "hono";

/** SHA-256 16 進(auth.ts 内部と同一。per-request key の KV キー算出用)。 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** キー → 値の固定 KV モック(未登録キーは null)。 */
function kvWith(store: Record<string, string>): KVNamespace {
  return { get: async (k: string) => store[k] ?? null } as unknown as KVNamespace;
}

/** authMiddleware を適用し、解決された plan/customerId を返す probe アプリ。 */
function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("/probe", authMiddleware);
  app.get("/probe", (c) => c.json({ plan: c.get("plan"), customerId: c.get("customerId") }));
  return app;
}

function call(headers: Record<string, string>, env: Record<string, unknown>) {
  return makeApp().request("/probe", { headers }, env);
}

const PER_REQ_KEY = "shrb_" + "a".repeat(32);
const LIC_KEY = "shrb_lic_" + "b".repeat(32);
const BASE_ENV = { API_VERSION: "test" };

describe("authMiddleware — 匿名 / inert", () => {
  it("キーなし → 匿名 Free(customerId=anon_)", async () => {
    const res = await call({}, { ...BASE_ENV, API_KEYS: kvWith({}) });
    const b = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(b.plan).toBe("free");
    expect(b.customerId).toMatch(/^anon_/);
  });

  it("API_KEYS 未 binding → どんなキーでも匿名 Free に pass-through(inert)", async () => {
    const res = await call({ "X-API-Key": PER_REQ_KEY }, BASE_ENV);
    const b = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(b.plan).toBe("free");
    expect(b.customerId).toMatch(/^anon_/);
  });
});

describe("authMiddleware — per-request key", () => {
  it("corporation プランを解決(集約フォーマット)", async () => {
    const hash = await sha256Hex(PER_REQ_KEY);
    const store = {
      [hash]: JSON.stringify({
        customerId: "cust_1",
        createdAt: "2026-06-01T00:00:00Z",
        apis: { corporation: { plan: "pro", status: "active" } },
      }),
    };
    const res = await call({ "X-API-Key": PER_REQ_KEY }, { ...BASE_ENV, API_KEYS: kvWith(store) });
    const b = (await res.json()) as any;
    expect(b.plan).toBe("pro");
    expect(b.customerId).toBe("cust_1");
  });

  it("corporation 未契約のキー(他 API 単独)→ Free + customerId 保持", async () => {
    const hash = await sha256Hex(PER_REQ_KEY);
    const store = {
      [hash]: JSON.stringify({
        customerId: "cust_addr_only",
        createdAt: "2026-06-01T00:00:00Z",
        apis: { address: { plan: "starter", status: "active" } },
      }),
    };
    const res = await call({ "X-API-Key": PER_REQ_KEY }, { ...BASE_ENV, API_KEYS: kvWith(store) });
    const b = (await res.json()) as any;
    expect(b.plan).toBe("free");
    expect(b.customerId).toBe("cust_addr_only");
  });

  it("旧フラットフォーマットは calendar 相当 → corporation 未契約 → Free", async () => {
    const hash = await sha256Hex(PER_REQ_KEY);
    const store = {
      [hash]: JSON.stringify({ plan: "starter", customerId: "legacy_1", createdAt: "2026-06-01T00:00:00Z" }),
    };
    const res = await call({ "X-API-Key": PER_REQ_KEY }, { ...BASE_ENV, API_KEYS: kvWith(store) });
    const b = (await res.json()) as any;
    expect(b.plan).toBe("free");
    expect(b.customerId).toBe("legacy_1");
  });

  it("suspended は 403 API_KEY_SUSPENDED", async () => {
    const hash = await sha256Hex(PER_REQ_KEY);
    const store = {
      [hash]: JSON.stringify({
        customerId: "cust_susp",
        createdAt: "2026-06-01T00:00:00Z",
        apis: { corporation: { plan: "pro", status: "suspended" } },
      }),
    };
    const res = await call({ "X-API-Key": PER_REQ_KEY }, { ...BASE_ENV, API_KEYS: kvWith(store) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("API_KEY_SUSPENDED");
  });

  it("未登録キー → 401", async () => {
    const res = await call({ "X-API-Key": PER_REQ_KEY }, { ...BASE_ENV, API_KEYS: kvWith({}) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("INVALID_API_KEY");
  });

  it("形式不正キー → 401", async () => {
    const res = await call({ "X-API-Key": "garbage" }, { ...BASE_ENV, API_KEYS: kvWith({}) });
    expect(res.status).toBe(401);
  });
});

describe("authMiddleware — Hub license", () => {
  function licenseStore(over: Record<string, unknown> = {}) {
    return {
      [`license:${LIC_KEY}`]: JSON.stringify({
        licenseKey: LIC_KEY,
        customerId: "org_1",
        sku: "hub_pro",
        entitledApis: ["address", "text", "calendar", "corporation"],
        status: "active",
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
        ...over,
      }),
    };
  }

  it("corporation entitlement あり → flat 無計測(plan=enterprise)", async () => {
    const res = await call({ "X-API-Key": LIC_KEY }, { ...BASE_ENV, API_KEYS: kvWith(licenseStore()) });
    const b = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(b.plan).toBe("enterprise");
    expect(b.customerId).toBe("org_1");
  });

  it("suspended license → 403 LICENSE_SUSPENDED", async () => {
    const res = await call({ "X-API-Key": LIC_KEY }, { ...BASE_ENV, API_KEYS: kvWith(licenseStore({ status: "suspended" })) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("LICENSE_SUSPENDED");
  });

  it("corporation を含まない license(address_managed)→ 403 LICENSE_TIER_INSUFFICIENT", async () => {
    const store = kvWith(licenseStore({ sku: "address_managed", entitledApis: ["address"] }));
    const res = await call({ "X-API-Key": LIC_KEY }, { ...BASE_ENV, API_KEYS: store });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("LICENSE_TIER_INSUFFICIENT");
  });

  it("未登録 license → 401", async () => {
    const res = await call({ "X-API-Key": LIC_KEY }, { ...BASE_ENV, API_KEYS: kvWith({}) });
    expect(res.status).toBe(401);
  });
});

describe("getAnonymousId", () => {
  it("同一 IP は決定的、異なる IP は別 id", async () => {
    const mk = (ip?: string) =>
      ({ req: { header: (h: string) => (h === "CF-Connecting-IP" ? ip : undefined) } } as unknown as Context<AppEnv>);
    const a1 = await getAnonymousId(mk("1.2.3.4"));
    const a2 = await getAnonymousId(mk("1.2.3.4"));
    const b = await getAnonymousId(mk("5.6.7.8"));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^anon_[0-9a-f]{16}$/);
  });
});
