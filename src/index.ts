import { Hono } from "hono";
import type { Context } from "hono";
import type {
  ApiError,
  BatchLookupItem,
  BatchResponse,
  CorporationRecord,
  Env,
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

/**
 * Shirabe Corporation Number API のエントリポイント。
 *
 * 純ロジック endpoint(health / validate / normalize)はデータ層なしで稼働。
 * D1 依存 endpoint(lookup / search / batch)は query ロジックを実装済みで、
 * D1 binding(CORP_DB)が未 provisioning(WS-2)の間は 503 を返す(provisioning 後は無改修で稼働)。
 */
const app = new Hono<{ Bindings: Env }>();

/** D1 データ層が未 provisioning のときに返すエラーコード。 */
const DATA_LAYER_UNAVAILABLE = "DATA_LAYER_UNAVAILABLE";

/** リクエスト body を JSON として読む(失敗時は null)。 */
async function readJson(c: Context<{ Bindings: Env }>): Promise<unknown> {
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

export default app;
