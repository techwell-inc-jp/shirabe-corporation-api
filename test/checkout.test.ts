import { describe, it, expect, vi, afterEach } from "vitest";
import app from "@/index";
import {
  createStripeCheckoutSession,
  generateApiKey,
  VALID_PLANS,
  API_MARKER,
} from "@/routes/checkout";

/** get/put を保持する最小 stateful KV モック(corp 専用 USAGE_LOGS 代役)。 */
function statefulKV() {
  const store = new Map<string, string>();
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

const PRICE_ENV = {
  STRIPE_PRICE_STARTER: "price_corp_starter",
  STRIPE_PRICE_PRO: "price_corp_pro",
  STRIPE_PRICE_ENTERPRISE: "price_corp_enterprise",
};

async function post(body: unknown, env: Record<string, unknown>, rawBody?: string): Promise<Response> {
  return app.request(
    "/api/v1/corporation/checkout",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody ?? JSON.stringify(body),
    },
    env
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/v1/corporation/checkout — バリデーション", () => {
  it("不正 JSON は 400 INVALID_REQUEST", async () => {
    const res = await post(undefined, { API_VERSION: "test" }, "not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("INVALID_REQUEST");
  });

  it("email 不正は 400", async () => {
    for (const email of [undefined, "", "no-at-sign"]) {
      const res = await post({ email, plan: "starter" }, { API_VERSION: "test", ...PRICE_ENV });
      expect(res.status).toBe(400);
    }
  });

  it("plan 不正は 400(free / 未知 plan を弾く)", async () => {
    for (const plan of [undefined, "free", "gold"]) {
      const res = await post({ email: "a@b.com", plan }, { API_VERSION: "test", ...PRICE_ENV });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/v1/corporation/checkout — 未構成(inert)", () => {
  it("Price ID 未設定は 500 INTERNAL_ERROR(課金未構成)", async () => {
    const res = await post(
      { email: "a@b.com", plan: "starter" },
      { API_VERSION: "test", STRIPE_SECRET_KEY: "sk_test_x" }
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("INTERNAL_ERROR");
  });

  it("STRIPE_SECRET_KEY 未設定は 500(Price 設定済でも)", async () => {
    const res = await post({ email: "a@b.com", plan: "pro" }, { API_VERSION: "test", ...PRICE_ENV });
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /api/v1/corporation/checkout — 正常系(fetch スタブ)", () => {
  it("checkout_url 返却 + pending を corp USAGE_LOGS に保存 + metadata.api=corporation", async () => {
    const { kv, store } = statefulKV();
    let captured: { url: string; body: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, body: String(init.body) };
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/sess_1" }), {
          status: 200,
        });
      })
    );

    const res = await post(
      { email: "buyer@example.com", plan: "starter" },
      { API_VERSION: "test", STRIPE_SECRET_KEY: "sk_test_x", USAGE_LOGS: kv, ...PRICE_ENV }
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).checkout_url).toBe("https://checkout.stripe.com/c/sess_1");

    // Stripe へ corp Price + metadata.api=corporation を送り、metered のため quantity 無し。
    expect(captured!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(captured!.body).toContain("price_corp_starter");
    expect(captured!.body).toContain(encodeURIComponent("metadata[api]") + "=corporation");
    expect(captured!.body).not.toContain("quantity");

    // pending が 1 件(checkout-pending:{hash})保存され、api=corporation を含む。
    const pendingEntries = [...store.keys()].filter((k) => k.startsWith("checkout-pending:"));
    expect(pendingEntries).toHaveLength(1);
    const pending = JSON.parse(store.get(pendingEntries[0]!)!);
    expect(pending.api).toBe(API_MARKER);
    expect(pending.plan).toBe("starter");
    expect(pending.email).toBe("buyer@example.com");
    expect(pending.apiKey).toMatch(/^shrb_[A-Za-z0-9]{32}$/);
  });

  it("Stripe が非 200 を返すと 502 CHECKOUT_FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 }))
    );
    const res = await post(
      { email: "a@b.com", plan: "enterprise" },
      { API_VERSION: "test", STRIPE_SECRET_KEY: "sk_test_x", USAGE_LOGS: statefulKV().kv, ...PRICE_ENV }
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe("CHECKOUT_FAILED");
  });
});

describe("createStripeCheckoutSession(直接)", () => {
  it("metadata と subscription_data を両方付与し url を返す", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ url: "https://x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await createStripeCheckoutSession({
      priceId: "price_x",
      apiKeyHash: "hash_x",
      plan: "pro",
      email: "a@b.com",
      stripeSecretKey: "sk_test_x",
      fetchImpl,
    });
    expect(out.url).toBe("https://x");
    expect(body).toContain(encodeURIComponent("subscription_data[metadata][api]") + "=corporation");
    expect(body).toContain(encodeURIComponent("metadata[apiKeyHash]") + "=hash_x");
  });

  it("url 欠落レスポンスは例外", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(
      createStripeCheckoutSession({
        priceId: "p",
        apiKeyHash: "h",
        plan: "starter",
        email: "a@b.com",
        stripeSecretKey: "sk",
        fetchImpl,
      })
    ).rejects.toThrow();
  });
});

describe("generateApiKey / VALID_PLANS", () => {
  it("shrb_ + 32 文字英数字", () => {
    expect(generateApiKey()).toMatch(/^shrb_[A-Za-z0-9]{32}$/);
  });
  it("有料 3 プランのみ", () => {
    expect([...VALID_PLANS]).toEqual(["starter", "pro", "enterprise"]);
  });
});

describe("GET /api/v1/corporation/checkout/success — 決済完了ページ(404 是正)", () => {
  it("session_id なしでも 200 HTML(キー未解決のフォールバック)", async () => {
    const res = await app.request("/api/v1/corporation/checkout/success", {}, { API_VERSION: "test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ご契約ありがとうございます");
    expect(html).toContain("一度しか表示されません");
  });

  it("Stripe session + USAGE_LOGS の checkout-pending から API キー平文を表示", async () => {
    const { kv } = statefulKV();
    const apiKey = generateApiKey();
    const hash = await import("@/util/sha256").then((m) => m.sha256Hex(apiKey));
    await kv.put(
      `checkout-pending:${hash}`,
      JSON.stringify({ apiKey, plan: "starter", email: "a@b.com" })
    );
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ metadata: { apiKeyHash: hash, plan: "starter" } }), { status: 200 })
    );
    const res = await app.request(
      "/api/v1/corporation/checkout/success?session_id=cs_test_123",
      {},
      { API_VERSION: "test", STRIPE_SECRET_KEY: "sk_test_x", USAGE_LOGS: kv }
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(apiKey);
    expect(html).toContain("starter");
  });
});

describe("GET /api/v1/corporation/checkout/cancel — キャンセルページ", () => {
  it("200 HTML(請求未発生の案内)", async () => {
    const res = await app.request("/api/v1/corporation/checkout/cancel", {}, { API_VERSION: "test" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("キャンセル");
    expect(html).toContain("請求は発生していません");
  });
});
