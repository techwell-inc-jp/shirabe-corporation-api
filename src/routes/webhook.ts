/**
 * Stripe Webhook 処理(法人番号 API 単独購入)
 *
 * POST /api/v1/corporation/webhook/stripe
 * - auth / usage 系ミドルウェアは適用しない(署名検証のみ)
 * - Stripe Webhook Secret で署名検証(Web Crypto HMAC-SHA256、暦/住所 API と同ロジック)
 *
 * 処理対象イベント(corp 関連のみ。metadata.api === "corporation" で判別):
 *   - checkout.session.completed     → 新規契約、AggregatedApiKeyInfo.apis.corporation を設定
 *                                       + stripe:customer-map(日次 reporter 用)+ stripe-reverse
 *   - invoice.payment_failed         → apis.corporation.status = "suspended"
 *   - invoice.payment_succeeded      → apis.corporation.status を "active" に復帰
 *   - customer.subscription.updated  → plan 変更を apis.corporation.plan に反映
 *   - customer.subscription.deleted  → apis.corporation.plan = "free"(キーは残す)+ customer-map 削除
 *
 * KV は **共有 API_KEYS の 1 キー集約構造**(`types/api-key`、address とミラー)で書き込む:
 *   - 既存キーがあれば apis.corporation のみマージし他 API(calendar/address)情報を保持
 *   - 既存が無ければ新規 AggregatedApiKeyInfo を作成
 *   - 旧フォーマット(暦 API 単独時代の flat)は migrate してから apis.corporation を追加
 *
 * ★ address との差分: corp は日次バッチ reporter(scripts/stripe-daily-report.ts、PR #16)で
 *   メーター報告するため、checkout.session.completed で corp 専用 USAGE_LOGS の
 *   `stripe:customer-map`(customerId → stripeCustomerId)を維持する(address はインライン
 *   メーターのため customer-map 不要)。reporter はこのマップで usage を Stripe customer に紐付ける。
 *
 * ★ inert: STRIPE_WEBHOOK_SECRET / API_KEYS / USAGE_LOGS 未設定の間は実質 no-op(本番挙動不変)。
 */
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import {
  isAggregatedApiKeyInfo,
  migrateToAggregated,
  type AggregatedApiKeyInfo,
  type ApiPlanInfo,
  type StoredApiKeyInfo,
} from "@/middleware/api-key";
import { sha256Hex } from "@/util/sha256";

export const webhook = new Hono<AppEnv>();

/** corp を示す metadata.api 値(checkout.ts と共有)。 */
const API_MARKER = "corporation" as const;

/** 日次 reporter が読む customer-map の KV キー(corp 専用 USAGE_LOGS、reporter の既定値と一致)。 */
const CUSTOMER_MAP_KEY = "stripe:customer-map";

/** 署名許容範囲(5 分)。 */
const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * cross-API correlation KV write(corp 側、weekly batch 集計用)。
 *
 * KV key: `correlation:{email_sha256}` を corp 専用 USAGE_LOGS に書込。
 * shirabe-assets/scripts/cross-api-aggregate.ts(weekly cron)が各 API の USAGE_LOGS から
 * correlation:* を email_sha256 で join し api_concurrency_rate を算出する。
 * Phase 1 範囲: checkout.session.completed のみ書込(drift 許容、calendar/address と同方針)。
 */
async function writeCorrelationEntry(
  usageLogsKV: KVNamespace,
  email: string,
  stripeCustomerId: string | undefined,
  plan: string,
  status: "active" | "suspended" | "canceled"
): Promise<void> {
  const emailNormalized = email.trim().toLowerCase();
  if (!emailNormalized) return;
  const emailHash = await sha256Hex(emailNormalized);
  const now = new Date().toISOString();
  const entry = {
    api: "corporation",
    stripe_customer_id: stripeCustomerId,
    plan,
    status,
    subscribed_at: now,
    updated_at: now,
  };
  await usageLogsKV.put(`correlation:${emailHash}`, JSON.stringify(entry));
}

// ─── 署名検証(暦/住所 API と同ロジック)──────────────────────────

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(",");
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

async function computeHmacSha256(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string
): Promise<boolean> {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!timestamp || signatures.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_SEC) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = await computeHmacSha256(webhookSecret, signedPayload);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

// ─── metadata ガード ──────────────────────────────────────────

/**
 * イベントが corp 関連かを判定する(api マーカー抽出)。
 * - checkout.session.completed / customer.subscription.*: object.metadata.api
 * - invoice.*: object.subscription_details.metadata.api
 * - 取得できない場合は undefined(個別ハンドラが apis.corporation の存在で判別)。
 */
function extractApiMarker(event: Record<string, unknown>): string | undefined {
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const obj = data?.object ?? {};

  const directMeta = (obj as { metadata?: Record<string, string> }).metadata;
  if (directMeta && typeof directMeta.api === "string") return directMeta.api;

  const subDetails = (obj as { subscription_details?: { metadata?: Record<string, string> } })
    .subscription_details;
  if (subDetails?.metadata && typeof subDetails.metadata.api === "string") {
    return subDetails.metadata.api;
  }

  return undefined;
}

// ─── KV ヘルパ ─────────────────────────────────────────────────

/** 共有 API_KEYS から AggregatedApiKeyInfo を読む。旧フォーマットは migrate する。 */
async function readAggregated(
  apiKeysKV: KVNamespace,
  apiKeyHash: string
): Promise<AggregatedApiKeyInfo | null> {
  const raw = await apiKeysKV.get(apiKeyHash);
  if (!raw) return null;
  let stored: StoredApiKeyInfo;
  try {
    stored = JSON.parse(raw) as StoredApiKeyInfo;
  } catch {
    return null;
  }
  return isAggregatedApiKeyInfo(stored) ? stored : migrateToAggregated(stored);
}

/** AggregatedApiKeyInfo を共有 API_KEYS に書く(apis.corporation のみ更新する想定)。 */
async function writeAggregated(
  apiKeysKV: KVNamespace,
  apiKeyHash: string,
  info: AggregatedApiKeyInfo
): Promise<void> {
  await apiKeysKV.put(apiKeyHash, JSON.stringify(info));
}

/** stripe-reverse で stripeCustomerId から customerId / apiKeyHash を引く。 */
async function lookupByStripeCustomer(
  stripeCustomerId: string,
  usageLogsKV: KVNamespace
): Promise<{ customerId: string; apiKeyHash: string } | null> {
  const reverseStr = await usageLogsKV.get(`stripe-reverse:${stripeCustomerId}`);
  if (!reverseStr) return null;
  const parts = reverseStr.split(",", 2);
  const customerId = parts[0];
  const apiKeyHash = parts[1];
  if (!customerId || !apiKeyHash) return null;
  return { customerId, apiKeyHash };
}

/** customer-map(customerId → {stripeCustomerId})に 1 件追加する。 */
async function upsertCustomerMap(
  usageLogsKV: KVNamespace,
  customerId: string,
  stripeCustomerId: string
): Promise<void> {
  const mapStr = await usageLogsKV.get(CUSTOMER_MAP_KEY);
  const map = mapStr ? (JSON.parse(mapStr) as Record<string, { stripeCustomerId: string }>) : {};
  map[customerId] = { stripeCustomerId };
  await usageLogsKV.put(CUSTOMER_MAP_KEY, JSON.stringify(map));
}

/** customer-map から 1 件削除する(解約時、reporter が以後 skip するため)。 */
async function removeFromCustomerMap(
  usageLogsKV: KVNamespace,
  customerId: string
): Promise<void> {
  const mapStr = await usageLogsKV.get(CUSTOMER_MAP_KEY);
  if (!mapStr) return;
  const map = JSON.parse(mapStr) as Record<string, { stripeCustomerId: string }>;
  if (!(customerId in map)) return;
  delete map[customerId];
  await usageLogsKV.put(CUSTOMER_MAP_KEY, JSON.stringify(map));
}

// ─── イベントハンドラ ─────────────────────────────────────────

async function handleCheckoutCompleted(
  event: Record<string, unknown>,
  apiKeysKV: KVNamespace,
  usageLogsKV: KVNamespace
): Promise<void> {
  const session = (event.data as { object?: Record<string, unknown> }).object ?? {};
  const metadata = (session as { metadata?: Record<string, string> }).metadata ?? {};
  const apiKeyHash = metadata.apiKeyHash;
  const plan = metadata.plan;
  const stripeCustomerId = (session as { customer?: string }).customer;
  const stripeSubscriptionId = (session as { subscription?: string }).subscription;

  if (!apiKeyHash || !plan) {
    console.error("[webhook:corporation] checkout.session.completed missing metadata");
    return;
  }

  // checkout-pending から生 API キー(未使用)と email を引く。
  const pendingStr = await usageLogsKV.get(`checkout-pending:${apiKeyHash}`);
  if (!pendingStr) {
    console.error("[webhook:corporation] checkout-pending not found for hash:", apiKeyHash);
    return;
  }
  const pending = JSON.parse(pendingStr) as { email?: string; api?: string };
  if (pending.api && pending.api !== API_MARKER) {
    // 他 API の pending を誤って掴んだ場合は無視。
    return;
  }

  const customerId = `cust_${apiKeyHash.slice(0, 16)}`;
  const now = new Date().toISOString();

  // 1. 共有 API_KEYS: 既存があればマージ、無ければ新規(apis.corporation を設定)。
  const existing = await readAggregated(apiKeysKV, apiKeyHash);
  const corpPlanInfo: ApiPlanInfo = {
    plan: plan as ApiPlanInfo["plan"],
    status: "active",
    stripeSubscriptionId,
    updatedAt: now,
  };
  const info: AggregatedApiKeyInfo = existing
    ? {
        ...existing,
        stripeCustomerId: stripeCustomerId ?? existing.stripeCustomerId,
        email: pending.email ?? existing.email,
        apis: { ...existing.apis, corporation: corpPlanInfo },
      }
    : {
        customerId,
        stripeCustomerId,
        email: pending.email,
        createdAt: now,
        apis: { corporation: corpPlanInfo },
      };
  await writeAggregated(apiKeysKV, apiKeyHash, info);

  // 2. stripe-reverse 登録(invoice.* / subscription.* の逆引き用)。
  if (stripeCustomerId) {
    await usageLogsKV.put(`stripe-reverse:${stripeCustomerId}`, `${info.customerId},${apiKeyHash}`);
  }

  // 3. customer-map 維持(日次 reporter が customerId → stripeCustomerId で usage を紐付け)。
  if (stripeCustomerId) {
    await upsertCustomerMap(usageLogsKV, info.customerId, stripeCustomerId);
  }

  // 4. email インデックス。
  if (pending.email) {
    await usageLogsKV.put(`email:${pending.email}`, apiKeyHash);
  }

  // 5. cross-API correlation。
  if (pending.email) {
    await writeCorrelationEntry(usageLogsKV, pending.email, stripeCustomerId, plan, "active");
  }

  // checkout-pending は TTL(1h)で自然失効に任せる(success ページ競合回避)。
}

async function handlePaymentFailed(
  event: Record<string, unknown>,
  apiKeysKV: KVNamespace,
  usageLogsKV: KVNamespace
): Promise<void> {
  const obj = (event.data as { object?: Record<string, unknown> }).object ?? {};
  const stripeCustomerId = (obj as { customer?: string }).customer;
  if (!stripeCustomerId) return;

  const lookup = await lookupByStripeCustomer(stripeCustomerId, usageLogsKV);
  if (!lookup) return;

  const info = await readAggregated(apiKeysKV, lookup.apiKeyHash);
  if (!info || !info.apis.corporation) return; // corp 未契約なら無視。
  info.apis.corporation = {
    ...info.apis.corporation,
    status: "suspended",
    updatedAt: new Date().toISOString(),
  };
  await writeAggregated(apiKeysKV, lookup.apiKeyHash, info);
}

async function handlePaymentSucceeded(
  event: Record<string, unknown>,
  apiKeysKV: KVNamespace,
  usageLogsKV: KVNamespace
): Promise<void> {
  const obj = (event.data as { object?: Record<string, unknown> }).object ?? {};
  const stripeCustomerId = (obj as { customer?: string }).customer;
  if (!stripeCustomerId) return;

  const lookup = await lookupByStripeCustomer(stripeCustomerId, usageLogsKV);
  if (!lookup) return;

  const info = await readAggregated(apiKeysKV, lookup.apiKeyHash);
  if (!info || !info.apis.corporation) return;
  if (info.apis.corporation.status === "suspended") {
    info.apis.corporation = {
      ...info.apis.corporation,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    await writeAggregated(apiKeysKV, lookup.apiKeyHash, info);
  }
}

async function handleSubscriptionUpdated(
  event: Record<string, unknown>,
  apiKeysKV: KVNamespace,
  usageLogsKV: KVNamespace,
  env: AppEnv["Bindings"]
): Promise<void> {
  const subscription = (event.data as { object?: Record<string, unknown> }).object ?? {};
  const stripeCustomerId = (subscription as { customer?: string }).customer;
  const stripeSubscriptionId = (subscription as { id?: string }).id;
  if (!stripeCustomerId || !stripeSubscriptionId) return;

  const lookup = await lookupByStripeCustomer(stripeCustomerId, usageLogsKV);
  if (!lookup) return;

  const info = await readAggregated(apiKeysKV, lookup.apiKeyHash);
  if (!info || !info.apis.corporation) return;

  // plan 変更検出: subscription.items.data[0].price.id を corp 用 Price ID と照合。
  const items = (subscription as { items?: { data?: Array<{ price?: { id?: string } }> } }).items;
  const priceId = items?.data?.[0]?.price?.id;
  let plan: ApiPlanInfo["plan"] | null = null;
  if (priceId === env.STRIPE_PRICE_STARTER) plan = "starter";
  else if (priceId === env.STRIPE_PRICE_PRO) plan = "pro";
  else if (priceId === env.STRIPE_PRICE_ENTERPRISE) plan = "enterprise";

  if (plan && plan !== info.apis.corporation.plan) {
    info.apis.corporation = {
      ...info.apis.corporation,
      plan,
      stripeSubscriptionId,
      updatedAt: new Date().toISOString(),
    };
    await writeAggregated(apiKeysKV, lookup.apiKeyHash, info);
  }
}

async function handleSubscriptionDeleted(
  event: Record<string, unknown>,
  apiKeysKV: KVNamespace,
  usageLogsKV: KVNamespace
): Promise<void> {
  const subscription = (event.data as { object?: Record<string, unknown> }).object ?? {};
  const stripeCustomerId = (subscription as { customer?: string }).customer;
  const stripeSubscriptionId = (subscription as { id?: string }).id;
  if (!stripeCustomerId || !stripeSubscriptionId) return;

  const lookup = await lookupByStripeCustomer(stripeCustomerId, usageLogsKV);
  if (!lookup) return;

  const info = await readAggregated(apiKeysKV, lookup.apiKeyHash);
  if (!info || !info.apis.corporation) return;

  // 対象 subscription が corp のものか確認(他 API の subscription なら無視)。
  if (
    info.apis.corporation.stripeSubscriptionId &&
    info.apis.corporation.stripeSubscriptionId !== stripeSubscriptionId
  ) {
    return;
  }

  info.apis.corporation = {
    plan: "free",
    status: "active",
    updatedAt: new Date().toISOString(),
  };
  await writeAggregated(apiKeysKV, lookup.apiKeyHash, info);

  // 解約後は usage が発生しないため customer-map から除去(reporter が skip_unmapped 扱い)。
  // stripe-reverse は保守的に残す(他 API が同一 stripe customer を使う可能性、害は軽微)。
  await removeFromCustomerMap(usageLogsKV, lookup.customerId);
}

// ─── エントリポイント ─────────────────────────────────────────

/**
 * dedupe キー TTL(秒)。Stripe の最大 retry window(3 日)に余裕を持たせ 7 日保持。
 * calendar #28 / address #17 と同値。
 */
const DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;

/** dedupe キー prefix(corp 専用 USAGE_LOGS 内、calendar/address と同一)。 */
const DEDUPE_KEY_PREFIX = "webhook-dedupe:";

webhook.post("/", async (c) => {
  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook:corporation] STRIPE_WEBHOOK_SECRET is not configured");
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Webhook not configured." } },
      500
    );
  }

  // KV binding 確認(provisioning 後は両方揃う。未 binding 時は誤処理を避け 500)。
  const apiKeysKV = c.env.API_KEYS;
  const usageLogsKV = c.env.USAGE_LOGS;
  if (!apiKeysKV || !usageLogsKV) {
    console.error("[webhook:corporation] API_KEYS / USAGE_LOGS not bound");
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Webhook storage not configured." } },
      500
    );
  }

  const signatureHeader = c.req.header("Stripe-Signature");
  if (!signatureHeader) {
    return c.json(
      { error: { code: "INVALID_SIGNATURE", message: "Missing Stripe-Signature header." } },
      401
    );
  }

  const rawBody = await c.req.text();

  const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret);
  if (!isValid) {
    return c.json(
      { error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature." } },
      401
    );
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body." } }, 400);
  }

  const eventType = typeof event.type === "string" ? event.type : "";
  const eventId = typeof event.id === "string" ? event.id : undefined;

  // metadata.api が指定されている場合は corp 以外を弾く(早期リターン)。
  // 注: 他 API skip は dedupe より前に行い、corp 以外の event.id を corp 側 KV に書かない
  //     (各 API の webhook が自分の namespace で別途 dedupe する)。
  const marker = extractApiMarker(event);
  if (marker && marker !== API_MARKER) {
    return c.json({ received: true, skipped: `api=${marker}` });
  }

  // Idempotency check(event.id ベース重複検出、calendar #28 / address #17 と同値)。
  if (eventId) {
    const dedupeKey = `${DEDUPE_KEY_PREFIX}${eventId}`;
    const existing = await usageLogsKV.get(dedupeKey);
    if (existing) {
      return c.json({ received: true, deduped: true });
    }
  }

  switch (eventType) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event, apiKeysKV, usageLogsKV);
      break;
    case "invoice.payment_failed":
      await handlePaymentFailed(event, apiKeysKV, usageLogsKV);
      break;
    case "invoice.payment_succeeded":
      await handlePaymentSucceeded(event, apiKeysKV, usageLogsKV);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event, apiKeysKV, usageLogsKV, c.env);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event, apiKeysKV, usageLogsKV);
      break;
    default:
      // 未対応イベントは 200 で ACK(Stripe のリトライを止める)。
      break;
  }

  // Mark as processed(handler 成功後、return 直前)。例外時は本行未到達 = Stripe retry に委ねる。
  if (eventId) {
    const dedupeKey = `${DEDUPE_KEY_PREFIX}${eventId}`;
    await usageLogsKV.put(dedupeKey, new Date().toISOString(), {
      expirationTtl: DEDUPE_TTL_SEC,
    });
  }

  return c.json({ received: true });
});
