import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AdminImportResponse,
  ApiError,
  BatchLookupItem,
  BatchResponse,
  AppEnv,
  CorporationRecord,
  LookupResponse,
  SearchResponse,
  ValidateResult,
} from "@/types";
import { isValidLawId, isWellFormedLawId } from "@/core/checksum";
import { buildAttribution } from "@/core/attribution";
import { normalizeCorporationName } from "@/core/normalize";
import {
  BATCH_MAX,
  buildBatchLookupStatement,
  buildLookupStatement,
  buildSearchStatement,
  mapRowToRecord,
  parseSearchParams,
  type CorporationRow,
} from "@/core/queries";
import { buildUpsertBatches, recordsFromCsv } from "@/core/bulk-import";
import { verifyAdminToken } from "@/core/admin-auth";
import { authMiddleware } from "@/middleware/auth";
import { usageCheckMiddleware } from "@/middleware/usage-check";
import { usageLoggerMiddleware } from "@/middleware/usage-logger";

/**
 * Shirabe Corporation Number API のエントリポイント。
 *
 * 純ロジック endpoint(health / validate / normalize)はデータ層なしで稼働。
 * D1 依存 endpoint(lookup / search / batch)は query ロジックを実装済みで、
 * D1 binding(CORP_DB)が未 provisioning(WS-2)の間は 503 を返す(provisioning 後は無改修で稼働)。
 */
const app = new Hono<AppEnv>();

/**
 * 計測対象の公開 API ルート(auth → usage-check → usage-logger を適用)。
 * health(公開疎通)と admin/import(独自 X-Admin-Token 認証)は **対象外**。
 * auth は plan/customerId を Context に設定し、usage-check が月間上限ゲートを掛け、
 * usage-logger が成功レスポンスを USAGE_LOGS KV に計上する(usage-check より内側 =
 * 429 は計上しない / 案 X 内部 enrich は非計上)。
 * binding 未設定の間は 3 者とも pass-through / 非計上 = inert(本番挙動不変)。
 */
const METERED_ROUTES = ["validate", "lookup", "search", "normalize", "batch"] as const;
for (const route of METERED_ROUTES) {
  app.use(`/api/v1/corporation/${route}`, authMiddleware, usageCheckMiddleware, usageLoggerMiddleware);
}

/** D1 データ層が未 provisioning のときに返すエラーコード。 */
const DATA_LAYER_UNAVAILABLE = "DATA_LAYER_UNAVAILABLE";

/** リクエスト body を JSON として読む(失敗時は null)。 */
async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** 統一フォーマットの 400(JSON 不正)。 */
function invalidJson(): ApiError {
  return { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } };
}

/** D1 未 provisioning 時の 503 本体。 */
function dataLayerUnavailable(endpoint: string): ApiError {
  return {
    error: {
      code: DATA_LAYER_UNAVAILABLE,
      message: `'${endpoint}' requires the corporation D1 data layer, which is not provisioned yet (WS-2). Logic is implemented; bind CORP_DB to enable.`,
    },
  };
}

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
    data_layer: c.env.CORP_DB ? "ready" : "unprovisioned",
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
  const body = (await readJson(c)) as { law_id?: unknown } | null;
  if (body === null) return c.json<ApiError>(invalidJson(), 400);

  const lawId = body.law_id;
  if (typeof lawId !== "string") {
    return c.json<ApiError>(
      { error: { code: "INVALID_REQUEST", message: "Field 'law_id' (string) is required." } },
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
 * 法人番号 1 件の lookup(最新履歴)。
 *
 * checksum 不正は 400(無駄な D1 アクセスを避ける)。D1 未 provisioning は 503。
 * 見つからない場合は 404。
 */
app.post("/api/v1/corporation/lookup", async (c) => {
  const body = (await readJson(c)) as { law_id?: unknown } | null;
  if (body === null) return c.json<ApiError>(invalidJson(), 400);

  const lawId = body.law_id;
  if (typeof lawId !== "string" || !isWellFormedLawId(lawId) || !isValidLawId(lawId)) {
    return c.json<ApiError>(
      { error: { code: "INVALID_LAW_ID", message: "Field 'law_id' must be a valid 13-digit corporate number (mod-9 checksum)." } },
      400
    );
  }

  if (!c.env.CORP_DB) return c.json<ApiError>(dataLayerUnavailable("lookup"), 503);

  const { sql, params } = buildLookupStatement(lawId);
  const row = await c.env.CORP_DB.prepare(sql).bind(...params).first<CorporationRow>();
  if (!row) {
    return c.json<ApiError>(
      { error: { code: "NOT_FOUND", message: `No corporation found for law_id '${lawId}'.` } },
      404
    );
  }

  const response: LookupResponse = {
    corporation: mapRowToRecord(row),
    attribution: buildAttribution(false),
  };
  return c.json(response, 200);
});

/**
 * 商号の前方一致検索(都道府県/市区町村コード絞り込み + ページング)。
 *
 * 入力不正は 400。D1 未 provisioning は 503。
 */
app.post("/api/v1/corporation/search", async (c) => {
  const body = (await readJson(c)) as Record<string, unknown> | null;
  if (body === null) return c.json<ApiError>(invalidJson(), 400);

  const parsed = parseSearchParams(body);
  if (!parsed.ok) {
    return c.json<ApiError>({ error: { code: "INVALID_REQUEST", message: parsed.message } }, 400);
  }

  if (!c.env.CORP_DB) return c.json<ApiError>(dataLayerUnavailable("search"), 503);

  const { sql, params } = buildSearchStatement(parsed.params);
  const { results } = await c.env.CORP_DB.prepare(sql).bind(...params).all<CorporationRow>();
  const records = results.map(mapRowToRecord);

  const response: SearchResponse = {
    results: records,
    count: records.length,
    limit: parsed.params.limit,
    offset: parsed.params.offset,
    attribution: buildAttribution(false),
  };
  return c.json(response, 200);
});

/**
 * 法人名の正規化(NFKC + 略記展開 + 法人種別分離)。データ層不要の純ロジック。
 */
app.post("/api/v1/corporation/normalize", async (c) => {
  const body = (await readJson(c)) as { name?: unknown } | null;
  if (body === null) return c.json<ApiError>(invalidJson(), 400);

  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json<ApiError>(
      { error: { code: "INVALID_REQUEST", message: "Field 'name' (non-empty string) is required." } },
      400
    );
  }
  return c.json(normalizeCorporationName(name), 200);
});

/**
 * 複数法人番号の一括 lookup。checksum 不正な id は valid=false で返す。
 *
 * D1 未 provisioning は 503。空配列 / 上限超過は 400。
 */
app.post("/api/v1/corporation/batch", async (c) => {
  const body = (await readJson(c)) as { law_ids?: unknown } | null;
  if (body === null) return c.json<ApiError>(invalidJson(), 400);

  const lawIds = body.law_ids;
  if (!Array.isArray(lawIds) || lawIds.length === 0) {
    return c.json<ApiError>(
      { error: { code: "INVALID_REQUEST", message: "Field 'law_ids' (non-empty string array) is required." } },
      400
    );
  }
  if (lawIds.length > BATCH_MAX) {
    return c.json<ApiError>(
      { error: { code: "BATCH_TOO_LARGE", message: `'law_ids' exceeds the maximum of ${BATCH_MAX}.` } },
      400
    );
  }

  // 形式 + checksum で valid/invalid を分類(入力順を保持)。
  const classified = lawIds.map((raw) => {
    const lawId = typeof raw === "string" ? raw : String(raw);
    const valid = typeof raw === "string" && isWellFormedLawId(raw) && isValidLawId(raw);
    return { lawId, valid };
  });

  if (!c.env.CORP_DB) return c.json<ApiError>(dataLayerUnavailable("batch"), 503);

  const validIds = [...new Set(classified.filter((x) => x.valid).map((x) => x.lawId))];
  const byLawId = new Map<string, CorporationRecord>();
  if (validIds.length > 0) {
    const { sql, params } = buildBatchLookupStatement(validIds);
    const { results } = await c.env.CORP_DB.prepare(sql).bind(...params).all<CorporationRow>();
    for (const row of results) {
      const record = mapRowToRecord(row);
      byLawId.set(record.lawId, record);
    }
  }

  const items: BatchLookupItem[] = classified.map(({ lawId, valid }) => {
    const corporation = valid ? byLawId.get(lawId) ?? null : null;
    return { lawId, valid, found: corporation !== null, corporation };
  });

  const response: BatchResponse = { results: items, attribution: buildAttribution(false) };
  return c.json(response, 200);
});

/**
 * admin データ投入(WS-4)。国税庁 CSV 1 ファイル分(全文)を body で受け、
 * 最新履歴を冪等 upsert する。取込ロジックは bulk-import.ts に集約(test 済み)。
 *
 * 認証: `X-Admin-Token` ヘッダを Secret `ADMIN_IMPORT_TOKEN` と定数時間比較。
 *   - Secret 未設定 → 503(機能無効)
 *   - トークン不一致/欠落 → 401
 * データ層: CORP_DB 未 provisioning は 503。
 *
 * 大容量対策: 呼出側は都道府県別ファイル単位で POST する(runbook 参照)。
 */
app.post("/api/v1/corporation/admin/import", async (c) => {
  const auth = verifyAdminToken(c.env.ADMIN_IMPORT_TOKEN, c.req.header("X-Admin-Token") ?? null);
  if (auth === "disabled") {
    return c.json<ApiError>(
      { error: { code: "ADMIN_DISABLED", message: "Admin import is disabled (ADMIN_IMPORT_TOKEN is not set)." } },
      503
    );
  }
  if (auth === "unauthorized") {
    return c.json<ApiError>(
      { error: { code: "UNAUTHORIZED", message: "Valid 'X-Admin-Token' header is required." } },
      401
    );
  }

  if (!c.env.CORP_DB) return c.json<ApiError>(dataLayerUnavailable("admin/import"), 503);

  const text = await c.req.text();
  if (text.trim().length === 0) {
    return c.json<ApiError>(
      { error: { code: "INVALID_REQUEST", message: "Request body must be a non-empty NTA CSV payload." } },
      400
    );
  }

  let skipped = 0;
  const records = recordsFromCsv(text, { onError: () => { skipped++; } });
  const importedAt = new Date().toISOString();
  const batches = buildUpsertBatches(records, importedAt);

  const db = c.env.CORP_DB;
  for (const batch of batches) {
    await db.batch(batch.map((s) => db.prepare(s.sql).bind(...s.params)));
  }

  const response: AdminImportResponse = {
    imported: records.length,
    skipped,
    batches: batches.length,
    importedAt,
  };
  return c.json(response, 200);
});

export default app;
