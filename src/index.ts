import { Hono } from "hono";
import type { ApiError, Env, ValidateResult } from "@/types";
import { isValidLawId, isWellFormedLawId } from "@/core/checksum";

/**
 * Shirabe Corporation Number API のエントリポイント。
 *
 * PoC 段階: health + validate(純ロジック、データ不要)を実装。
 * lookup / search / normalize / batch は D1 データ層(WS-2/WS-4)接続後に実装。
 */
const app = new Hono<{ Bindings: Env }>();

/** データ層待ちエンドポイントが返すエラーコード。 */
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
 * 法人番号の形式 + チェックディジット検証(国税庁 mod 9)。
 *
 * データ層不要の純ロジック。registry 実在確認は D1 接続後(現状 existsInRegistry=null)。
 *
 * @returns ValidateResult(200)。入力不正時は ApiError(400)。
 */
app.post("/api/v1/corporation/validate", async (c) => {
  let body: { law_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json<ApiError>(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      400
    );
  }
  const lawId = body?.law_id;
  if (typeof lawId !== "string") {
    return c.json<ApiError>(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Field 'law_id' (string) is required.",
        },
      },
      400
    );
  }
  const formatValid = isWellFormedLawId(lawId);
  const checksumValid = formatValid && isValidLawId(lawId);
  const result: ValidateResult = {
    lawId,
    formatValid,
    checksumValid,
    valid: formatValid && checksumValid,
    existsInRegistry: null,
    note: "Registry existence check is pending the D1 data layer (WS-2/WS-4).",
  };
  return c.json(result, 200);
});

/**
 * データ層が必要なエンドポイントの 501 レスポンスを生成する純粋ヘルパ。
 *
 * @param endpoint - 対象エンドポイント名。
 * @returns 統一フォーマットの ApiError。
 */
function notImplemented(endpoint: string): ApiError {
  return {
    error: {
      code: NOT_IMPLEMENTED,
      message: `'${endpoint}' is not implemented yet (pending D1 data layer, WS-2/WS-4).`,
    },
  };
}

/** D1 データ層に依存し、PoC では未実装のエンドポイント。 */
const DATA_DEPENDENT_ENDPOINTS = ["lookup", "search", "normalize", "batch"] as const;

for (const ep of DATA_DEPENDENT_ENDPOINTS) {
  app.post(`/api/v1/corporation/${ep}`, (c) =>
    c.json<ApiError>(notImplemented(ep), 501)
  );
}

export default app;
