/**
 * Hub license の読み取り + entitlement 判定(法人番号 API 側)。
 *
 * ★ cross-repo 契約: calendar の `src/licensing/license-store.ts` / `src/types/license.ts` と
 *   **完全に同一の KV schema**(共有 `API_KEYS` namespace、`license:{licenseKey}` key、
 *   `StoredLicense` 値)。発行は calendar(#19 Stripe part)に集約し、corp は **読み取り専用**。
 *   schema を変える場合は両 repo を同時に更新すること(片側だけ変えると license が壊れる)。
 *
 * per-request API key(`shrb_` + 32、middleware/api-key.ts)とは別レイヤの flat license。
 * 1 契約 1 key で B2B 4 大 identifier(住所・人名/text・暦・法人番号)を横断利用する権利を表す。
 */

/** license key の prefix(per-request `shrb_` と判別)。 */
export const LICENSE_KEY_PREFIX = "shrb_lic_";

/** prefix を除いた本体長(per-request key と同じ 32 文字)。 */
const LICENSE_KEY_BODY_LEN = 32;

/** license key 形状の検証用パターン(`shrb_lic_` + 32 文字英数字)。 */
const LICENSE_KEY_PATTERN = new RegExp(`^${LICENSE_KEY_PREFIX}[A-Za-z0-9]{${LICENSE_KEY_BODY_LEN}}$`);

/** license の状態(Stripe webhook が遷移を駆動)。 */
export type LicenseStatus = "active" | "suspended";

/** license 対象 SKU(per_request は license 契約でないため含まない)。 */
export type LicenseSku = "address_managed" | "hub_pro" | "hub_enterprise";

/** Shirabe ファミリーの API 名(entitlement 対象)。 */
export type LicensedApi = "address" | "text" | "calendar" | "corporation";

/**
 * KV(共有 API_KEYS namespace、`license:{licenseKey}`)に保存される license レコード。
 * calendar の `StoredLicense` と構造一致(corp は読み取りのみ)。
 */
export interface StoredLicense {
  licenseKey: string;
  customerId: string;
  sku: LicenseSku;
  entitledApis: LicensedApi[];
  status: LicenseStatus;
  createdAt: string;
  updatedAt: string;
  email?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

/** license key 形状判定(`shrb_lic_` + 32 文字英数字)。 */
export function isLicenseKey(key: string): boolean {
  return LICENSE_KEY_PATTERN.test(key);
}

/** KV(API_KEYS)上の license レコード key を組み立てる(calendar と同一)。 */
export function licenseKvKey(licenseKey: string): string {
  return `license:${licenseKey}`;
}

/**
 * license が指定 API の横断利用を許可しているか判定する(純粋関数)。
 *
 * active かつ entitledApis に含まれる場合のみ true。suspended は常に false。
 *
 * @param license 対象 license レコード
 * @param api 判定対象 API
 * @returns 許可されていれば true
 */
export function licenseGrants(license: StoredLicense, api: LicensedApi): boolean {
  return license.status === "active" && license.entitledApis.includes(api);
}

/**
 * 共有 API_KEYS namespace から license を読み取る(calendar の getLicense と同一挙動)。
 *
 * @param kv 共有 API_KEYS namespace
 * @param licenseKey `X-API-Key` で渡された license key
 * @returns StoredLicense または null(形式不正 / 未登録 / JSON 不正)
 */
export async function getLicense(
  kv: KVNamespace,
  licenseKey: string
): Promise<StoredLicense | null> {
  if (!isLicenseKey(licenseKey)) return null;
  const raw = await kv.get(licenseKvKey(licenseKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredLicense;
  } catch {
    return null;
  }
}
