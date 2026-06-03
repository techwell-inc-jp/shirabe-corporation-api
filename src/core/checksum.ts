/**
 * 法人番号(13 桁)のチェックディジット検証。
 *
 * 国税庁方式(mod 9): 先頭 1 桁 = チェックディジット、下 12 桁 = 基礎番号。
 *   チェックディジット = 9 − ( Σ(Pn × Qn) を 9 で除した余り )
 *   Pn = 基礎番号の最下位を 1 桁目とした n 桁目の数字
 *   Qn = n が奇数のとき 1、偶数のとき 2
 *
 * WS-1 実測の実在法人番号 `1000012160145`(弘前検察審査会)で手計算検証済み。
 */

const LAW_ID_PATTERN = /^\d{13}$/;
const BASE_PATTERN = /^\d{12}$/;
const BASE_LENGTH = 12;
const ASCII_ZERO = 48;

/**
 * 基礎番号(下 12 桁)からチェックディジットを算出する純粋関数。
 *
 * @param base12 - 12 桁の ASCII 数字文字列(基礎番号)。
 * @returns チェックディジット(1〜9)。
 * @throws 入力が 12 桁数字でない場合。
 */
export function computeCheckDigit(base12: string): number {
  if (!BASE_PATTERN.test(base12)) {
    throw new Error("base12 must be a 12-digit numeric string");
  }
  let sum = 0;
  for (let i = 0; i < BASE_LENGTH; i++) {
    // n = i + 1(基礎番号の最下位から数えた桁位置)
    const digit = base12.charCodeAt(BASE_LENGTH - 1 - i) - ASCII_ZERO;
    const weight = (i + 1) % 2 === 1 ? 1 : 2; // n 奇数→1 / 偶数→2
    sum += digit * weight;
  }
  return 9 - (sum % 9);
}

/**
 * 13 桁数字の形式チェックのみ(チェックディジット非検証)。
 *
 * @param lawId - 検証対象。
 * @returns 13 桁の数字なら true。
 */
export function isWellFormedLawId(lawId: string): boolean {
  return LAW_ID_PATTERN.test(lawId);
}

/**
 * 法人番号(13 桁)の形式 + チェックディジットを検証する。
 *
 * @param lawId - 検証対象。13 桁数字以外は false。
 * @returns 形式 OK かつチェックディジット一致なら true。
 */
export function isValidLawId(lawId: string): boolean {
  if (!LAW_ID_PATTERN.test(lawId)) return false;
  const check = lawId.charCodeAt(0) - ASCII_ZERO;
  return computeCheckDigit(lawId.slice(1)) === check;
}
