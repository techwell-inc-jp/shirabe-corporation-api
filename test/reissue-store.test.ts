/**
 * self-serve キー再発行ロジック(トークン管理 + per-request キー回転)のテスト(法人番号 API)
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  EMAIL_INDEX_PREFIX,
  STRIPE_REVERSE_PREFIX,
  REISSUE_TOKEN_PREFIX,
  generatePerRequestKey,
  generateReissueToken,
  resolveReissueTarget,
  putReissueToken,
  consumeReissueToken,
  rotatePerRequestKey,
  type ReissueTokenRecord,
} from "@/keys/reissue-store";
import { sha256Hex } from "@/util/sha256";

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

describe("key / token generation", () => {
  it("generatePerRequestKey は shrb_ + 32 英数字", () => {
    expect(generatePerRequestKey()).toMatch(/^shrb_[a-zA-Z0-9]{32}$/);
  });
  it("generatePerRequestKey は毎回異なる", () => {
    expect(new Set(Array.from({ length: 50 }, () => generatePerRequestKey())).size).toBe(50);
  });
  it("generateReissueToken は 64 hex", () => {
    expect(generateReissueToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveReissueTarget", () => {
  let usageLogs: KVNamespace;
  beforeEach(() => {
    usageLogs = statefulKV();
  });

  it("email: 索引があれば apiKeyHash を返す", async () => {
    await usageLogs.put(`${EMAIL_INDEX_PREFIX}a@example.com`, "hash_abc");
    expect(await resolveReissueTarget(usageLogs, "a@example.com")).toBe("hash_abc");
  });

  it("索引が無ければ null", async () => {
    expect(await resolveReissueTarget(usageLogs, "none@example.com")).toBeNull();
  });
});

describe("token put / consume (single-use)", () => {
  let usageLogs: KVNamespace;
  beforeEach(() => {
    usageLogs = statefulKV();
  });

  const record: ReissueTokenRecord = {
    ref: "hash_x",
    email: "x@example.com",
    createdAt: "2026-06-25T00:00:00.000Z",
  };

  it("put → consume で復元できる", async () => {
    const token = generateReissueToken();
    await putReissueToken(usageLogs, token, record);
    expect(await consumeReissueToken(usageLogs, token)).toEqual(record);
  });

  it("hash を KV key にする(平文トークンでは引けない)", async () => {
    const token = generateReissueToken();
    await putReissueToken(usageLogs, token, record);
    const tokenHash = await sha256Hex(token);
    expect(await usageLogs.get(`${REISSUE_TOKEN_PREFIX}${tokenHash}`)).toBeTruthy();
    expect(await usageLogs.get(`${REISSUE_TOKEN_PREFIX}${token}`)).toBeNull();
  });

  it("single-use(2 回目は null)", async () => {
    const token = generateReissueToken();
    await putReissueToken(usageLogs, token, record);
    expect(await consumeReissueToken(usageLogs, token)).not.toBeNull();
    expect(await consumeReissueToken(usageLogs, token)).toBeNull();
  });

  it("未知トークンは null", async () => {
    expect(await consumeReissueToken(usageLogs, generateReissueToken())).toBeNull();
  });
});

describe("rotatePerRequestKey", () => {
  let apiKeys: KVNamespace;
  let usageLogs: KVNamespace;
  beforeEach(() => {
    apiKeys = statefulKV();
    usageLogs = statefulKV();
  });

  async function seed(email: string) {
    const oldKey = "shrb_" + "A".repeat(32);
    const oldHash = await sha256Hex(oldKey);
    const record = {
      customerId: "cust_old",
      stripeCustomerId: "cus_stripe_1",
      email,
      createdAt: "2026-06-01T00:00:00.000Z",
      apis: { corporation: { plan: "starter", status: "active" } },
    };
    await apiKeys.put(oldHash, JSON.stringify(record));
    await usageLogs.put(`${EMAIL_INDEX_PREFIX}${email}`, oldHash);
    await usageLogs.put(`${STRIPE_REVERSE_PREFIX}cus_stripe_1`, `cust_old,${oldHash}`);
    return { oldHash };
  }

  it("新キー発行・旧ハッシュ失効・索引更新(customerId 据え置き)", async () => {
    const email = "paid@example.com";
    const { oldHash } = await seed(email);

    const newKey = await rotatePerRequestKey(apiKeys, usageLogs, oldHash, email);
    expect(newKey).toMatch(/^shrb_[a-zA-Z0-9]{32}$/);
    const newHash = await sha256Hex(newKey!);

    expect(await apiKeys.get(oldHash)).toBeNull();
    const moved = JSON.parse((await apiKeys.get(newHash))!);
    expect(moved.customerId).toBe("cust_old");
    expect(moved.apis.corporation.plan).toBe("starter");
    expect(await usageLogs.get(`${EMAIL_INDEX_PREFIX}${email}`)).toBe(newHash);
    expect(await usageLogs.get(`${STRIPE_REVERSE_PREFIX}cus_stripe_1`)).toBe(`cust_old,${newHash}`);
  });

  it("対象ハッシュが無ければ null", async () => {
    expect(await rotatePerRequestKey(apiKeys, usageLogs, "missing", "x@example.com")).toBeNull();
  });

  it("stripeCustomerId 無しでも回転する", async () => {
    const email = "nostripe@example.com";
    const oldKey = "shrb_" + "B".repeat(32);
    const oldHash = await sha256Hex(oldKey);
    await apiKeys.put(
      oldHash,
      JSON.stringify({ customerId: "cust_ns", createdAt: "x", apis: { corporation: { plan: "pro" } } })
    );
    await usageLogs.put(`${EMAIL_INDEX_PREFIX}${email}`, oldHash);
    const newKey = await rotatePerRequestKey(apiKeys, usageLogs, oldHash, email);
    expect(newKey).not.toBeNull();
    expect(await usageLogs.get(`${EMAIL_INDEX_PREFIX}${email}`)).toBe(await sha256Hex(newKey!));
  });
});
