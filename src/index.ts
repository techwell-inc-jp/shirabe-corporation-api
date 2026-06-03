import { Hono } from "hono";
import type { ApiError, Env } from "@/types";

/**
 * Shirabe Corporation Number API のエントリポイント。
 *
 * PoC 段階: ヘルスチェックのみ実装し、5 endpoints は 501 を返す。
 * 実装は storage(D1)確定後に routes/ へ追加する。
 */
const app = new Hono<{ Bindings: Env }>();

/** PoC で未実装のエンドポイントが返すエラーコード。 */
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";

/**
 * ヘルスチェック。デプロイ疎通とバージョン確認に用いる。
 *
 * @returns API 名・バージョン・稼働状態の JSON。
 */
app.get("/api/v1/corporation/health", (c) =>
  c.json({
    status: "ok",
    api: "corporation",
    version: c.env.API_VERSION ?? "0.0.0-poc",
  })
);

/**
 * 未実装エンドポイント用の 501 レスポンスを生成する純粋ヘルパ。
 *
 * @param endpoint - 対象エンドポイント名(エラーメッセージ用)。
 * @returns 統一フォーマットの ApiError。
 */
function notImplemented(endpoint: string): ApiError {
  return {
    error: {
      code: NOT_IMPLEMENTED,
      message: `'${endpoint}' is not implemented yet (PoC stage). Tracking: corporation-api scoping §4.`,
    },
  };
}

const PLANNED_ENDPOINTS = [
  "lookup",
  "search",
  "normalize",
  "validate",
  "batch",
] as const;

for (const ep of PLANNED_ENDPOINTS) {
  app.post(`/api/v1/corporation/${ep}`, (c) =>
    c.json<ApiError>(notImplemented(ep), 501)
  );
}

export default app;
