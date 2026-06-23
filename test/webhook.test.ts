import { describe, it, expect } from "vitest";
import app from "@/index";
import { verifyStripeSignature } from "@/routes/webhook";

/** get/put/delete を保持する最小 stateful KV モック。 */
function statefulKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

const SECRET = "whsec_test";
const HASH = "a".repeat(64);
const CUSTOMER_ID = `cust_${HASH.slice(0, 16)}`; // cust_aaaaaaaaaaaaaaaa
const STRIPE_CUST = "cus_test_1";

/** webhook の実装と同じ HMAC-SHA256 hex 署名を計算する。 */
async function computeSig(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeEnv(over: Record<string, unknown> = {}) {
  const apiKeys = statefulKV();
  const usage = statefulKV();
  const env = {
    API_VERSION: "test",
    STRIPE_WEBHOOK_SECRET: SECRET,
    API_KEYS: apiKeys.kv,
    USAGE_LOGS: usage.kv,
    ...over,
  };
  return { env, apiKeys, usage };
}

async function postSigned(
  rawBody: string,
  env: Record<string, unknown>,
  secret = SECRET
): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await computeSig(secret, `${ts}.${rawBody}`);
  return app.request(
    "/api/v1/corporation/webhook/stripe",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${sig}` },
      body: rawBody,
    },
    env
  );
}

const completedEvent = (over: Record<string, unknown> = {}) => ({
  id: "evt_completed_1",
  type: "checkout.session.completed",
  data: {
    object: {
      metadata: { apiKeyHash: HASH, plan: "starter", api: "corporation" },
      customer: STRIPE_CUST,
      subscription: "sub_1",
      ...over,
    },
  },
});

function seedPending(usage: ReturnType<typeof statefulKV>) {
  usage.store.set(
    `checkout-pending:${HASH}`,
    JSON.stringify({ apiKey: `shrb_${"x".repeat(32)}`, plan: "starter", email: "buyer@example.com", api: "corporation" })
  );
}

function seedCorpKey(apiKeys: ReturnType<typeof statefulKV>, planOver: Record<string, unknown> = {}) {
  apiKeys.store.set(
    HASH,
    JSON.stringify({
      customerId: CUSTOMER_ID,
      stripeCustomerId: STRIPE_CUST,
      email: "buyer@example.com",
      createdAt: "2026-06-01T00:00:00Z",
      apis: { corporation: { plan: "starter", status: "active", stripeSubscriptionId: "sub_1", ...planOver } },
    })
  );
}

describe("verifyStripeSignature(単体)", () => {
  it("正しい署名は true、改竄ボディは false", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await computeSig(SECRET, `${ts}.{"a":1}`);
    expect(await verifyStripeSignature(`{"a":1}`, `t=${ts},v1=${sig}`, SECRET)).toBe(true);
    expect(await verifyStripeSignature(`{"a":2}`, `t=${ts},v1=${sig}`, SECRET)).toBe(false);
  });

  it("期限切れ timestamp は false", async () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const sig = await computeSig(SECRET, `${old}.x`);
    expect(await verifyStripeSignature("x", `t=${old},v1=${sig}`, SECRET)).toBe(false);
  });
});

describe("webhook — 未構成 / 署名(inert / 防御)", () => {
  it("STRIPE_WEBHOOK_SECRET 未設定は 500", async () => {
    const { env } = makeEnv({ STRIPE_WEBHOOK_SECRET: undefined });
    const res = await postSigned(JSON.stringify(completedEvent()), env);
    expect(res.status).toBe(500);
  });

  it("KV binding 未設定は 500", async () => {
    const env = { API_VERSION: "test", STRIPE_WEBHOOK_SECRET: SECRET };
    const res = await postSigned(JSON.stringify(completedEvent()), env);
    expect(res.status).toBe(500);
  });

  it("Stripe-Signature ヘッダ無しは 401", async () => {
    const { env } = makeEnv();
    const res = await app.request(
      "/api/v1/corporation/webhook/stripe",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env
    );
    expect(res.status).toBe(401);
  });

  it("署名不正は 401", async () => {
    const { env } = makeEnv();
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.request(
      "/api/v1/corporation/webhook/stripe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=deadbeef` },
        body: JSON.stringify(completedEvent()),
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it("正しい署名だが不正 JSON は 400", async () => {
    const { env } = makeEnv();
    const res = await postSigned("not json", env);
    expect(res.status).toBe(400);
  });
});

describe("webhook — checkout.session.completed", () => {
  it("apis.corporation 発行 + stripe-reverse + customer-map + email + correlation", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedPending(usage);

    const res = await postSigned(JSON.stringify(completedEvent()), env);
    expect(res.status).toBe(200);

    // 共有 API_KEYS に apis.corporation = active。
    const info = JSON.parse(apiKeys.store.get(HASH)!);
    expect(info.apis.corporation.plan).toBe("starter");
    expect(info.apis.corporation.status).toBe("active");
    expect(info.customerId).toBe(CUSTOMER_ID);
    expect(info.stripeCustomerId).toBe(STRIPE_CUST);

    // stripe-reverse(corp 専用 USAGE_LOGS)。
    expect(usage.store.get(`stripe-reverse:${STRIPE_CUST}`)).toBe(`${CUSTOMER_ID},${HASH}`);

    // customer-map(日次 reporter 用)。
    const map = JSON.parse(usage.store.get("stripe:customer-map")!);
    expect(map[CUSTOMER_ID]).toEqual({ stripeCustomerId: STRIPE_CUST });

    // email インデックス + correlation。
    expect(usage.store.get("email:buyer@example.com")).toBe(HASH);
    expect([...usage.store.keys()].some((k) => k.startsWith("correlation:"))).toBe(true);
  });

  it("既存キーの他 API(apis.address)を保持してマージする", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedPending(usage);
    apiKeys.store.set(
      HASH,
      JSON.stringify({
        customerId: CUSTOMER_ID,
        createdAt: "2026-06-01T00:00:00Z",
        apis: { address: { plan: "pro", status: "active" } },
      })
    );

    await postSigned(JSON.stringify(completedEvent()), env);
    const info = JSON.parse(apiKeys.store.get(HASH)!);
    expect(info.apis.address.plan).toBe("pro"); // 既存 API を破壊しない
    expect(info.apis.corporation.plan).toBe("starter");
  });

  it("pending 不在では発行しない(metadata あっても）", async () => {
    const { env, apiKeys } = makeEnv();
    const res = await postSigned(JSON.stringify(completedEvent()), env);
    expect(res.status).toBe(200);
    expect(apiKeys.store.get(HASH)).toBeUndefined();
  });
});

describe("webhook — api マーカーガード / dedupe", () => {
  it("metadata.api=address は skip(corp KV を書かない)", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedPending(usage);
    const ev = completedEvent({ metadata: { apiKeyHash: HASH, plan: "starter", api: "address" } });
    const res = await postSigned(JSON.stringify(ev), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skipped).toBe("api=address");
    expect(apiKeys.store.get(HASH)).toBeUndefined();
  });

  it("同一 event.id の再送は deduped(二重処理しない)", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedPending(usage);
    const raw = JSON.stringify(completedEvent());
    await postSigned(raw, env);
    // 1 回目で発行済み。customer-map を意図的に汚し、再処理で上書きされないことを確認。
    const res2 = await postSigned(raw, env);
    expect(((await res2.json()) as any).deduped).toBe(true);
    // customer-map は 1 件のまま。
    const map = JSON.parse(usage.store.get("stripe:customer-map")!);
    expect(Object.keys(map)).toEqual([CUSTOMER_ID]);
    expect(apiKeys.store.get(HASH)).toBeDefined();
  });
});

describe("webhook — status 遷移", () => {
  it("invoice.payment_failed → apis.corporation.status=suspended", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedCorpKey(apiKeys);
    usage.store.set(`stripe-reverse:${STRIPE_CUST}`, `${CUSTOMER_ID},${HASH}`);

    const ev = { id: "evt_pf", type: "invoice.payment_failed", data: { object: { customer: STRIPE_CUST } } };
    await postSigned(JSON.stringify(ev), env);
    expect(JSON.parse(apiKeys.store.get(HASH)!).apis.corporation.status).toBe("suspended");
  });

  it("invoice.payment_succeeded → suspended から active に復帰", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedCorpKey(apiKeys, { status: "suspended" });
    usage.store.set(`stripe-reverse:${STRIPE_CUST}`, `${CUSTOMER_ID},${HASH}`);

    const ev = { id: "evt_ps", type: "invoice.payment_succeeded", data: { object: { customer: STRIPE_CUST } } };
    await postSigned(JSON.stringify(ev), env);
    expect(JSON.parse(apiKeys.store.get(HASH)!).apis.corporation.status).toBe("active");
  });

  it("customer.subscription.deleted → plan=free + customer-map 除去", async () => {
    const { env, apiKeys, usage } = makeEnv();
    seedCorpKey(apiKeys);
    usage.store.set(`stripe-reverse:${STRIPE_CUST}`, `${CUSTOMER_ID},${HASH}`);
    usage.store.set("stripe:customer-map", JSON.stringify({ [CUSTOMER_ID]: { stripeCustomerId: STRIPE_CUST } }));

    const ev = {
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: STRIPE_CUST } },
    };
    await postSigned(JSON.stringify(ev), env);

    expect(JSON.parse(apiKeys.store.get(HASH)!).apis.corporation.plan).toBe("free");
    expect(JSON.parse(usage.store.get("stripe:customer-map")!)[CUSTOMER_ID]).toBeUndefined();
  });
});
