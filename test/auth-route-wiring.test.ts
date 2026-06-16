import { describe, it, expect } from "vitest";
import app from "@/index";

/**
 * index.ts の wiring 検証: auth → usage-check が **metered routes のみ**に適用され、
 * health(公開)と admin/import(独自トークン認証)は対象外であること。
 */

/** 形式不正キーでも 401 を出さない = auth 未適用、を判定するための KV(空)。 */
function kvEmpty(): KVNamespace {
  return { get: async () => null } as unknown as KVNamespace;
}

const ENV = { API_VERSION: "test", API_KEYS: kvEmpty() };

describe("auth route wiring", () => {
  it("metered route(validate)は auth 適用 → 形式不正キーで 401", async () => {
    const res = await app.request(
      "/api/v1/corporation/validate",
      { method: "POST", headers: { "X-API-Key": "garbage", "Content-Type": "application/json" }, body: "{}" },
      ENV
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("INVALID_API_KEY");
  });

  it("health は auth 非適用(公開疎通)→ 形式不正キーでも 200", async () => {
    const res = await app.request(
      "/api/v1/corporation/health",
      { headers: { "X-API-Key": "garbage" } },
      ENV
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).api).toBe("corporation");
  });

  it("admin/import は auth(X-API-Key)非適用 → 独自トークン経路へ(401 INVALID_API_KEY ではない)", async () => {
    // ADMIN_IMPORT_TOKEN 未設定 → admin 認証で 503 ADMIN_DISABLED。authMiddleware が横取りしていない証左。
    const res = await app.request(
      "/api/v1/corporation/admin/import",
      { method: "POST", headers: { "X-API-Key": "garbage" }, body: "dummy" },
      ENV
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("ADMIN_DISABLED");
  });

  it("metered route はキーなしなら匿名 Free で通過(validate は純ロジック)", async () => {
    const res = await app.request(
      "/api/v1/corporation/validate",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ law_id: "1234567890123" }) },
      ENV
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as any).valid).toBe("boolean");
  });
});
