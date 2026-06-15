/**
 * 内部 enrich subrequest(案 X)の識別(法人番号 API 版)。
 *
 * calendar の enrich endpoint(`POST /api/v1/enrich`)は corporation API を same-zone
 * subrequest で呼び、`X-Shirabe-Internal` に共有トークンを載せる。このトークンが
 * `INTERNAL_ENRICH_TOKEN` Secret と一致するとき、当該リクエストは課金対象外(非計上)とし、
 * 月間利用量カウント・月間上限ゲートに計上しない(暦/住所と同設計)。
 *
 * 出典: shirabe-assets/implementation-orders/20260611-hub-enrich-endpoint-scoping.md §3.2 案 X
 * 送信側: shirabe-calendar/src/enrich/downstream.ts(`X-Shirabe-Internal` 送出)
 *
 * fail-closed(課金回避の悪用防止):
 * - `INTERNAL_ENRICH_TOKEN` 未設定 → 常に false(通常どおり計上)。
 * - ヘッダ欠如・トークン不一致 → false。
 * 定数時間比較(`timingSafeEqual`)で timing attack を回避する。
 */
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import { timingSafeEqual } from "@/core/admin-auth";

/** 内部 subrequest 識別ヘッダ名(calendar downstream.ts の INTERNAL_HEADER と一致させる)。 */
export const INTERNAL_ENRICH_HEADER = "X-Shirabe-Internal";

/**
 * リクエストが正規の内部 enrich subrequest かを判定する。
 *
 * @param c - Hono コンテキスト。
 * @returns 正規の内部 subrequest なら true(= 非計上扱い)。
 */
export function isInternalEnrichRequest(c: Context<AppEnv>): boolean {
  const expected = c.env.INTERNAL_ENRICH_TOKEN;
  if (!expected) return false; // 未設定は honor しない(fail-closed)
  const provided = c.req.header(INTERNAL_ENRICH_HEADER);
  if (!provided) return false;
  return timingSafeEqual(expected, provided);
}
