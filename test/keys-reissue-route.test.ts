/**
 * POST /api/v1/corporation/keys/reissue + 確定フローのテスト(法人番号 API)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { keysReissue } from "@/routes/keys-reissue";
import {
  EMAIL_INDEX_PREFIX,
  consumeReissueToken,
  rotatePerRequestKey,
} from "@/keys/reissue-store";
import { sha256Hex } from "@/util/sha256";
import type { AppEnv, Env, EmailSendMessage } from "@/types";

/** get/put/delete を保持する最小 stateful KV モック(webhook.test.ts と同形)。 */
function statefulKV(seed: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

function createCtx() {
  const sent: EmailSendMessage[] = [];
  const env = {
    API_KEYS: statefulKV(),
    USAGE_LOGS: statefulKV(),
    API_VERSION: "test",
    EMAIL: {
      send: async (m: EmailSendMessage) => {
        sent.push(m);
        return {};
      },
    },
  } as unknown as Env;
  return { env, sent };
}

function tokenFromMail(mail: EmailSendMessage | undefined): string {
  const match = (mail?.text ?? "").match(/token=([0-9a-f]{64})/);
  const token = match?.[1];
  if (!token) throw new Error("token not found");
  return token;
}

describe("POST /api/v1/corporation/keys/reissue", () => {
  let app: Hono<AppEnv>;
  let ctx: ReturnType<typeof createCtx>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
    app.route("/api/v1/corporation/keys", keysReissue);
    ctx = createCtx();
  });

  async function seed(email: string) {
    const key = "shrb_" + "Z".repeat(32);
    const hash = await sha256Hex(key);
    await ctx.env.API_KEYS!.put(
      hash,
      JSON.stringify({
        customerId: "cust_seed",
        stripeCustomerId: "cus_seed",
        email,
        createdAt: "x",
        apis: { corporation: { plan: "pro", status: "active" } },
      })
    );
    await ctx.env.USAGE_LOGS!.put(`${EMAIL_INDEX_PREFIX}${email}`, hash);
    return hash;
  }

  it("JSON: 該当なしでも 200 汎用 + 送信なし", async () => {
    const res = await app.request(
      "/api/v1/corporation/keys/reissue",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "no@example.com" }) },
      ctx.env
    );
    expect(res.status).toBe(200);
    expect(ctx.sent.length).toBe(0);
  });

  it("JSON: 該当ありで 200 + 検証メール送信", async () => {
    await seed("paid@example.com");
    const res = await app.request(
      "/api/v1/corporation/keys/reissue",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "paid@example.com" }) },
      ctx.env
    );
    expect(res.status).toBe(200);
    expect(ctx.sent.length).toBe(1);
    expect(tokenFromMail(ctx.sent[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("JSON: 不正 email は 400", async () => {
    const res = await app.request(
      "/api/v1/corporation/keys/reissue",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "bad" }) },
      ctx.env
    );
    expect(res.status).toBe(400);
  });

  it("end-to-end: 受付 → token → 確定回転で旧失効・新有効・索引更新", async () => {
    const email = "e2e@example.com";
    const oldHash = await seed(email);
    await app.request(
      "/api/v1/corporation/keys/reissue",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
      ctx.env
    );
    const token = tokenFromMail(ctx.sent[0]);

    const record = await consumeReissueToken(ctx.env.USAGE_LOGS!, token);
    expect(record).not.toBeNull();
    const newKey = await rotatePerRequestKey(ctx.env.API_KEYS!, ctx.env.USAGE_LOGS!, record!.ref, record!.email);
    expect(newKey).toMatch(/^shrb_[a-zA-Z0-9]{32}$/);

    expect(await ctx.env.API_KEYS!.get(oldHash)).toBeNull();
    const newHash = await sha256Hex(newKey!);
    expect(await ctx.env.API_KEYS!.get(newHash)).toBeTruthy();
    expect(await ctx.env.USAGE_LOGS!.get(`${EMAIL_INDEX_PREFIX}${email}`)).toBe(newHash);
    expect(await consumeReissueToken(ctx.env.USAGE_LOGS!, token)).toBeNull();
  });
});
