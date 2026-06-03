/**
 * Shirabe Corporation Number API — 型定義集約。
 * 規約: 型定義は types に集約(project CLAUDE.md §5)。
 */

/**
 * Cloudflare Workers の環境バインディング。
 * PoC 段階では vars のみ。D1 / KV binding は storage 確定後に追加する。
 */
export interface Env {
  /** API バージョン(wrangler.toml [vars])。 */
  API_VERSION: string;
}

/**
 * 統一エラーレスポンス(project CLAUDE.md §5)。
 * すべての異常系はこの形でクライアントへ返す。
 */
export interface ApiError {
  error: {
    /** 機械可読なエラーコード(UPPER_SNAKE_CASE)。 */
    code: string;
    /** 人間/AI 可読の説明。 */
    message: string;
    /** 追加情報(任意)。 */
    details?: unknown;
  };
}
