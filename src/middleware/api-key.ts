/**
 * 共有 API_KEYS namespace に保存される per-request API キーのデータ構造(法人番号 API 側)。
 *
 * ★ cross-repo 契約: calendar / address の `src/types/api-key.ts` と **同一の型定義**。
 *   新フォーマット(1 キー集約 `apis.{name}`)と旧フォーマット(暦単独フラット)の両方を
 *   読み取り可能にする。corp は **読み取り専用**(発行・書込は calendar の webhook に集約)。
 *
 * license key(`shrb_lic_`、core/license.ts)とは別レイヤ。per-request key は `shrb_` + 32。
 */

/** 単一 API 内のプラン状態。 */
export interface ApiPlanInfo {
  plan: "free" | "starter" | "pro" | "enterprise";
  /** 未設定は "active" 扱い。 */
  status?: "active" | "suspended";
  stripeSubscriptionId?: string;
  updatedAt?: string;
}

/** 【新フォーマット】1 キー集約構造。 */
export interface AggregatedApiKeyInfo {
  customerId: string;
  stripeCustomerId?: string;
  email?: string;
  createdAt: string;
  apis: {
    calendar?: ApiPlanInfo;
    address?: ApiPlanInfo;
    corporation?: ApiPlanInfo;
    [apiName: string]: ApiPlanInfo | undefined;
  };
}

/** 【旧フォーマット】暦 API 単独時代のフラット形式(corporation には該当しないが互換読込)。 */
export interface LegacyApiKeyInfo {
  plan: "free" | "starter" | "pro" | "enterprise";
  customerId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  email?: string;
  status?: "active" | "suspended";
  createdAt: string;
}

/** KV から読み取る際の Union 型。 */
export type StoredApiKeyInfo = AggregatedApiKeyInfo | LegacyApiKeyInfo;

/** 新フォーマット判定(type guard)。 */
export function isAggregatedApiKeyInfo(info: StoredApiKeyInfo): info is AggregatedApiKeyInfo {
  return "apis" in info && typeof (info as AggregatedApiKeyInfo).apis === "object";
}

/**
 * 旧フォーマット → 新フォーマットの読み取り時変換(in-memory のみ、KV 書き戻しなし)。
 *
 * 旧フォーマットは暦 API 単独のプランを表すため `apis.calendar` にマップする。
 * 法人番号 API のプランは未設定扱い(= `apis.corporation` なし)になる。
 */
export function migrateToAggregated(legacy: LegacyApiKeyInfo): AggregatedApiKeyInfo {
  return {
    customerId: legacy.customerId,
    stripeCustomerId: legacy.stripeCustomerId,
    email: legacy.email,
    createdAt: legacy.createdAt,
    apis: {
      calendar: {
        plan: legacy.plan,
        status: legacy.status ?? "active",
        stripeSubscriptionId: legacy.stripeSubscriptionId,
      },
    },
  };
}

/**
 * 特定 API の ApiPlanInfo を取得するヘルパ。
 *
 * - 新フォーマットなら `apis[apiName]` をそのまま返す
 * - 旧フォーマットなら calendar 相当に変換(corporation は未契約 = undefined)
 * - 対象 API が未契約なら undefined(呼び出し側で匿名 Free 扱い)
 *
 * @param stored KV から読んだ値
 * @param apiName 解決対象 API(corp では "corporation")
 */
export function resolveApiPlan(
  stored: StoredApiKeyInfo,
  apiName: "calendar" | "address" | "corporation"
): ApiPlanInfo | undefined {
  const aggregated = isAggregatedApiKeyInfo(stored) ? stored : migrateToAggregated(stored);
  return aggregated.apis[apiName];
}
