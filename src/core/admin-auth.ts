/**
 * admin 操作(データ投入)用の Secret トークン検証。
 *
 * トークンは `wrangler secret put ADMIN_IMPORT_TOKEN` で注入し、コードに直書きしない
 * (親 §0 / §6)。比較はタイミング攻撃を避けるため定数時間で行う。
 */

/**
 * 2 文字列を定数時間で比較する(早期 return しない)。
 *
 * 長さが異なる場合も全長を走査してから false を返し、長さ差からの漏洩を避ける。
 *
 * @param a - 比較対象 A。
 * @param b - 比較対象 B。
 * @returns 完全一致なら true。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** admin トークン検証の結果。 */
export type AdminAuthResult = "disabled" | "unauthorized" | "ok";

/**
 * 設定済みトークンと提示トークンを照合する。
 *
 * - 未設定(Secret 未注入)→ `disabled`(機能無効、503 を返す想定)
 * - 提示なし / 空 → `unauthorized`
 * - 定数時間比較で一致 → `ok`、不一致 → `unauthorized`
 *
 * @param configured - `env.ADMIN_IMPORT_TOKEN`(未設定は undefined)。
 * @param provided - リクエストヘッダの提示値(なければ null)。
 * @returns 検証結果。
 */
export function verifyAdminToken(
  configured: string | undefined,
  provided: string | null
): AdminAuthResult {
  if (configured === undefined || configured.length === 0) return "disabled";
  if (provided === null || provided.length === 0) return "unauthorized";
  return timingSafeEqual(configured, provided) ? "ok" : "unauthorized";
}
