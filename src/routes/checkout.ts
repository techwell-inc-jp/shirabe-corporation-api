/**
 * Stripe Checkout Session 作成(法人番号 API 単独購入)
 *
 * POST /api/v1/corporation/checkout
 *   Request:  { email: string, plan: "starter" | "pro" | "enterprise" }
 *   Response: { checkout_url: string }
 *
 * address API 側 `shirabe-address-api/src/routes/checkout.ts` を法人番号 API 用にミラー。
 *
 * 相違点:
 * - Price ID は corp 専用 metered Price(starter/pro/enterprise、住所クラス ¥0.5/0.3/0.1)
 * - session.metadata に `api="corporation"` を付与(webhook 側で対象 API 判別に使用)
 * - success_url / cancel_url は corp 専用パス
 * - 生 API キーは corp 専用 USAGE_LOGS に `checkout-pending:{hash}` として 1 時間保存。
 *   他 API(暦/住所)とは別 namespace なので競合しない。
 *
 * ★ inert: STRIPE_SECRET_KEY / Price ID 未設定の間は 500 を返し、課金は発生しない(本番挙動不変)。
 * ★ Stripe SDK は使わず fetch で REST 直叩き(Cloudflare Workers 互換 + 親 §4)。
 */
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import { sha256Hex } from "@/util/sha256";

export const checkout = new Hono<AppEnv>();

/** 有料プラン名(Free は対象外、購入導線なし)。 */
const VALID_PLANS = ["starter", "pro", "enterprise"] as const;
type PaidPlan = (typeof VALID_PLANS)[number];

/** メールアドレスの簡易バリデーション。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** API キーに使うランダム英数字の文字セット。 */
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** checkout-pending の TTL(1 時間 = 3600 秒、親 §4 の 60 秒下限を充足)。 */
const PENDING_TTL = 3600;

/** corp の checkout で識別用に付与する metadata.api 値(webhook と共有)。 */
export const API_MARKER = "corporation" as const;

/**
 * `shrb_` + 32 文字ランダム英数字の per-request API キーを生成する(暦/住所 API と同形式)。
 */
function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let key = "shrb_";
  for (let i = 0; i < 32; i++) {
    const idx = bytes[i] as number;
    key += CHARSET[idx % CHARSET.length];
  }
  return key;
}

/**
 * プラン名に対応する corp 専用 Stripe Price ID を env から取得する。
 */
function getPriceId(plan: PaidPlan, env: AppEnv["Bindings"]): string | undefined {
  const map: Record<PaidPlan, string | undefined> = {
    starter: env.STRIPE_PRICE_STARTER,
    pro: env.STRIPE_PRICE_PRO,
    enterprise: env.STRIPE_PRICE_ENTERPRISE,
  };
  return map[plan];
}

export type CreateSessionParams = {
  priceId: string;
  apiKeyHash: string;
  plan: PaidPlan;
  email: string;
  stripeSecretKey: string;
  /** テスト用 fetch 差し替え。 */
  fetchImpl?: typeof fetch;
};

/**
 * Stripe Checkout Session を作成する(fetch で REST API 直接呼出)。
 *
 * metered Price のため quantity は送らない(数量は Billing Meter Events から自動算出)。
 * metadata.api = "corporation" を session と subscription の両方に付与する:
 * - session.metadata: checkout.session.completed イベントで参照
 * - subscription_data[metadata]: 後続の invoice.* / customer.subscription.* イベントで参照
 */
export async function createStripeCheckoutSession(
  params: CreateSessionParams
): Promise<{ url: string }> {
  const body = new URLSearchParams();
  body.append("mode", "subscription");
  body.append("line_items[0][price]", params.priceId);
  // metered 価格では quantity を指定不可(Meter Events から算出)。
  body.append("customer_email", params.email);
  body.append("metadata[apiKeyHash]", params.apiKeyHash);
  body.append("metadata[plan]", params.plan);
  body.append("metadata[api]", API_MARKER);
  // subscription にも同じ metadata を継承させる(invoice.* / subscription.* 側で参照)。
  body.append("subscription_data[metadata][api]", API_MARKER);
  body.append("subscription_data[metadata][apiKeyHash]", params.apiKeyHash);
  body.append("subscription_data[metadata][plan]", params.plan);
  body.append(
    "success_url",
    "https://shirabe.dev/api/v1/corporation/checkout/success?session_id={CHECKOUT_SESSION_ID}"
  );
  body.append("cancel_url", "https://shirabe.dev/api/v1/corporation/checkout/cancel");

  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(params.stripeSecretKey + ":")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe API error (${res.status}): ${err.slice(0, 300)}`);
  }

  const session = (await res.json()) as { url?: string };
  if (!session.url) {
    throw new Error("Stripe checkout session response missing url");
  }
  return { url: session.url };
}

checkout.post("/", async (c) => {
  // ---- リクエストボディ解析 ----
  let body: { email?: string; plan?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Request body must be valid JSON with email and plan.",
        },
      },
      400
    );
  }

  const { email, plan } = body;

  // ---- バリデーション ----
  if (!email || !EMAIL_PATTERN.test(email)) {
    return c.json(
      { error: { code: "INVALID_REQUEST", message: "A valid email address is required." } },
      400
    );
  }

  if (!plan || !VALID_PLANS.includes(plan as PaidPlan)) {
    return c.json(
      { error: { code: "INVALID_REQUEST", message: `plan must be one of: ${VALID_PLANS.join(", ")}` } },
      400
    );
  }

  const paidPlan = plan as PaidPlan;

  // ---- Price ID 取得(未設定 = 当該プラン未構成)----
  const priceId = getPriceId(paidPlan, c.env);
  if (!priceId) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: `Stripe Price ID for plan "${paidPlan}" is not configured.`,
        },
      },
      500
    );
  }

  // ---- STRIPE_SECRET_KEY 確認(未設定 = 課金未構成 = inert)----
  const stripeSecretKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Payment system is not configured (STRIPE_SECRET_KEY missing).",
        },
      },
      500
    );
  }

  // ---- API キー生成 + ハッシュ化 ----
  const apiKey = generateApiKey();
  const apiKeyHash = await sha256Hex(apiKey);

  // ---- Stripe Checkout Session 作成 ----
  let checkoutUrl: string;
  try {
    const session = await createStripeCheckoutSession({
      priceId,
      apiKeyHash,
      plan: paidPlan,
      email,
      stripeSecretKey,
    });
    checkoutUrl = session.url;
  } catch (err) {
    console.error("[checkout:corporation] Stripe Checkout Session creation failed:", err);
    return c.json(
      {
        error: {
          code: "CHECKOUT_FAILED",
          message: "Failed to create checkout session. Please try again.",
        },
      },
      502
    );
  }

  // ---- 生 API キー + email + plan を corp 専用 USAGE_LOGS に一時保存(TTL 1 時間)----
  //   webhook が checkout.session.completed の metadata.apiKeyHash で引き当て、
  //   apis.corporation を発行する。他 API の USAGE_LOGS とは別 namespace で競合しない。
  //   USAGE_LOGS 未 binding 時は pending を保存できないが、Stripe 課金未構成(上で 500)の
  //   間は本行に到達しない。
  const pendingKey = `checkout-pending:${apiKeyHash}`;
  const pendingData = JSON.stringify({
    apiKey,
    plan: paidPlan,
    email,
    api: API_MARKER,
  });
  if (c.env.USAGE_LOGS) {
    await c.env.USAGE_LOGS.put(pendingKey, pendingData, { expirationTtl: PENDING_TTL });
  }

  return c.json({ checkout_url: checkoutUrl });
});

// テスト用 export
export { generateApiKey, VALID_PLANS };
