/**
 * API キー認証ミドルウェア(法人番号 API 版)。
 *
 * `X-API-Key` を解決し、後段の usage-check が使う `plan` / `customerId` を Context に設定する。
 * 2 種類のキーを受ける(共有 API_KEYS namespace、cross-repo 契約):
 *  - **per-request key**(`shrb_` + 32): SHA-256 hash で引き、`apis.corporation` のプランを解決。
 *  - **Hub license**(`shrb_lic_` + 32): `license:{key}` を読み、corporation entitlement を判定。
 *    license は flat 契約(無計測)のため plan="enterprise" 相当(usage-check 無制限)で通す。
 *
 * ★ inert / 後方安全:
 *   - `API_KEYS` 未 binding(WS-2 前)→ どんなキーでも匿名 Free に pass-through(挙動不変)。
 *   - キーなし → 匿名 Free(`customerId = anon_<ip_hash>`)。corp Free 枠 5,000 回/月の対象。
 *   - calendar の `src/middleware/auth.ts` を corporation 向けにミラー。
 */
import type { Context, Next } from "hono";
import type { AppEnv, ApiError } from "@/types";
import { resolveApiPlan, type StoredApiKeyInfo } from "@/middleware/api-key";
import { getLicense, isLicenseKey, licenseGrants } from "@/core/license";

/** per-request API キーの形式: `shrb_` + 32 文字英数字(license key の `shrb_lic_` とは非衝突)。 */
const API_KEY_PATTERN = /^shrb_[a-zA-Z0-9]{32}$/;

/** 401(無効/未登録キー)。 */
function invalidKey(): ApiError {
  return { error: { code: "INVALID_API_KEY", message: "Invalid or missing API key. Include X-API-Key header." } };
}

/** 文字列を SHA-256 16 進文字列にする(calendar と同一実装)。 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 匿名ユーザーの customerId を生成する(`anon_<ip_hash 先頭16>`、calendar と同一)。
 * `CF-Connecting-IP` 欠如時は "unknown" を IP の代わりに用いる。
 */
export async function getAnonymousId(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const hash = await sha256Hex(ip);
  return `anon_${hash.slice(0, 16)}`;
}

/**
 * 認証ミドルウェア。`plan` / `customerId` を Context に設定して next() する。
 * 認証エラー(未登録キー / suspended / entitlement 不足)は即時レスポンスを返す。
 */
export async function authMiddleware(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const apiKey = c.req.header("X-API-Key");

  // キーなし → 匿名 Free。
  if (!apiKey) {
    c.set("plan", "free");
    c.set("customerId", await getAnonymousId(c));
    return next();
  }

  // API_KEYS 未 binding(WS-2 前)→ 認証できないので匿名 Free に pass-through(inert)。
  const kv = c.env.API_KEYS;
  if (!kv) {
    c.set("plan", "free");
    c.set("customerId", await getAnonymousId(c));
    return next();
  }

  // Hub license(`shrb_lic_`)。corporation entitlement があれば flat 無計測で通す。
  if (isLicenseKey(apiKey)) {
    const license = await getLicense(kv, apiKey);
    if (!license) return c.json<ApiError>(invalidKey(), 401);
    if (license.status === "suspended") {
      return c.json<ApiError>(
        { error: { code: "LICENSE_SUSPENDED", message: "License suspended due to payment failure. Update payment at: https://shirabe.dev/billing" } },
        403
      );
    }
    if (!licenseGrants(license, "corporation")) {
      return c.json<ApiError>(
        { error: { code: "LICENSE_TIER_INSUFFICIENT", message: `This license does not include the corporation API (sku: ${license.sku}).` } },
        403
      );
    }
    // flat license = 無計測。usage-check の無制限枠(enterprise)で通す。
    c.set("plan", "enterprise");
    c.set("customerId", license.customerId);
    return next();
  }

  // per-request key(`shrb_` + 32)。
  if (API_KEY_PATTERN.test(apiKey)) {
    const hash = await sha256Hex(apiKey);
    const raw = await kv.get(hash);
    if (!raw) return c.json<ApiError>(invalidKey(), 401);

    let stored: StoredApiKeyInfo;
    try {
      stored = JSON.parse(raw) as StoredApiKeyInfo;
    } catch {
      return c.json<ApiError>(invalidKey(), 401);
    }

    const planInfo = resolveApiPlan(stored, "corporation");
    // corporation 未契約のキー(他 API 単独契約)→ 匿名 Free 相当(customerId は保持)。
    if (!planInfo) {
      c.set("plan", "free");
      c.set("customerId", stored.customerId);
      return next();
    }
    if (planInfo.status === "suspended") {
      return c.json<ApiError>(
        { error: { code: "API_KEY_SUSPENDED", message: "API key suspended due to payment failure. Update payment at: https://shirabe.dev/billing" } },
        403
      );
    }
    c.set("plan", planInfo.plan);
    c.set("customerId", stored.customerId);
    return next();
  }

  // 形式不正。
  return c.json<ApiError>(invalidKey(), 401);
}
