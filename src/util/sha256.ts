/**
 * SHA-256 16 進文字列ユーティリティ(法人番号 API 版)。
 *
 * per-request API キーの KV キー(= キー平文の SHA-256 hex)算出と、
 * cross-API correlation の email ハッシュ化に用いる。
 * calendar / address の同名関数と同一実装(cross-repo で hash が一致する必要がある)。
 *
 * ★ middleware/auth.ts も同一ロジックの内部 sha256Hex を持つ(発行前から稼働しており
 *   依存を増やさないため独立)。本ユーティリティは checkout / webhook(発行系)で使う。
 */

/**
 * 入力文字列の SHA-256 を 16 進小文字文字列で返す。
 *
 * @param input - ハッシュ対象の文字列(API キー平文 / 正規化済み email 等)。
 * @returns 64 文字の 16 進文字列。
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
