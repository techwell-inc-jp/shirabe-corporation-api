/**
 * D1 クエリ層(lookup / search)— 純粋な SQL 組み立て + 行マッピング。
 *
 * D1 binding(CORP_DB)を直接触らない純粋関数群。実 D1 provisioning(WS-2)前でも
 * Vitest で完全に test 可能にし、provisioning 後は handler が `.bind(...params)` で
 * そのまま使える(infra 非依存実装)。
 *
 * SQL は positional placeholder `?`(D1 の `.bind(...)` が順序束縛)。
 * 基本フィルタは WS-1 §5「最新履歴=1 AND 検索対象除外=0」(csv-importer.isActiveSearchable と同条件)。
 */

import type { CorporationRecord } from "@/types";

/** D1 corporations 表の 1 行(snake_case 列、latest/search_excluded は 0|1)。 */
export interface CorporationRow {
  law_id: string;
  name: string;
  name_kana: string | null;
  name_english: string | null;
  corp_type: string | null;
  prefecture: string | null;
  city: string | null;
  street: string | null;
  prefecture_code: string | null;
  city_code: string | null;
  postal_code: string | null;
  assigned_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  successor_law_id: string | null;
  latest: number;
  search_excluded: number;
}

/** 準備済みステートメント(SQL + 順序束縛パラメータ)。 */
export interface PreparedStatement {
  sql: string;
  params: unknown[];
}

/** search のデフォルト・上限件数。 */
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 100;

/**
 * D1 行を CorporationRecord に変換する(csv-importer.mapRow と同じ正規化形へ収束)。
 *
 * 0|1 の INTEGER を boolean に、null 列はそのまま保持する。
 *
 * @param row D1 から取得した corporations 行
 * @returns 正規化済み法人レコード
 */
export function mapRowToRecord(row: CorporationRow): CorporationRecord {
  return {
    lawId: row.law_id,
    name: row.name,
    nameKana: row.name_kana,
    nameEnglish: row.name_english,
    corpType: row.corp_type,
    prefecture: row.prefecture,
    city: row.city,
    street: row.street,
    prefectureCode: row.prefecture_code,
    cityCode: row.city_code,
    postalCode: row.postal_code,
    assignedAt: row.assigned_at,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
    successorLawId: row.successor_law_id,
    latest: row.latest === 1,
    searchExcluded: row.search_excluded === 1,
  };
}

/**
 * law_id 単体 lookup の SQL を組み立てる(最新履歴のみ)。
 *
 * @param lawId 13 桁法人番号(呼出側で checksum 検証済み想定)
 * @returns 準備済みステートメント
 */
export function buildLookupStatement(lawId: string): PreparedStatement {
  return {
    sql: "SELECT * FROM corporations WHERE law_id = ? AND latest = 1 LIMIT 1",
    params: [lawId],
  };
}

/** batch lookup の最大件数(1 リクエストあたり)。 */
export const BATCH_MAX = 100;

/**
 * 複数 law_id の一括 lookup SQL を組み立てる(IN 句、最新履歴のみ)。
 *
 * 呼出側で checksum 検証済み・重複排除済みの非空配列を渡す想定。
 *
 * @param lawIds 法人番号配列(1..BATCH_MAX、検証済み)
 * @returns 準備済みステートメント
 */
export function buildBatchLookupStatement(lawIds: readonly string[]): PreparedStatement {
  const placeholders = lawIds.map(() => "?").join(", ");
  return {
    sql: `SELECT * FROM corporations WHERE law_id IN (${placeholders}) AND latest = 1`,
    params: [...lawIds],
  };
}

/** LIKE のメタ文字(% _ \)を無害化する(前方一致を意図通りにする)。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** search の入力パラメータ(parse 済み)。 */
export interface SearchParams {
  /** 商号の前方一致キー(trim 済み・非空)。 */
  name: string;
  /** 都道府県コード絞り込み(任意)。 */
  prefectureCode?: string;
  /** 市区町村コード絞り込み(任意)。 */
  cityCode?: string;
  /** 取得件数(1..SEARCH_LIMIT_MAX)。 */
  limit: number;
  /** オフセット(>=0)。 */
  offset: number;
  /** true なら検索対象除外も含める(既定 false)。 */
  includeExcluded?: boolean;
}

/**
 * 商号前方一致 + 任意フィルタ + ページングの検索 SQL を組み立てる。
 *
 * name は LIKE 'x%'(idx_corporations_name 利用)。メタ文字は ESCAPE で無害化。
 *
 * @param p parse 済み検索パラメータ
 * @returns 準備済みステートメント
 */
export function buildSearchStatement(p: SearchParams): PreparedStatement {
  const where: string[] = ["latest = 1"];
  const params: unknown[] = [];

  if (!p.includeExcluded) where.push("search_excluded = 0");

  params.push(`${escapeLike(p.name)}%`);
  where.push("name LIKE ? ESCAPE '\\'");

  if (p.prefectureCode) {
    params.push(p.prefectureCode);
    where.push("prefecture_code = ?");
  }
  if (p.cityCode) {
    params.push(p.cityCode);
    where.push("city_code = ?");
  }

  params.push(p.limit, p.offset);
  const sql =
    `SELECT * FROM corporations WHERE ${where.join(" AND ")} ` +
    `ORDER BY name LIMIT ? OFFSET ?`;
  return { sql, params };
}

/** parseSearchParams の結果(成功 or バリデーションエラー)。 */
export type SearchParamsResult =
  | { ok: true; params: SearchParams }
  | { ok: false; message: string };

/** 数値らしき入力を整数化する(失敗時 undefined)。 */
function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return parseInt(value, 10);
  return undefined;
}

/** 文字列フィルタを正規化(空文字は undefined)。 */
function optionalStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * 生入力(query/body)を検証して SearchParams を返す。
 *
 * name 必須(trim 後非空)。limit は 1..SEARCH_LIMIT_MAX にクランプ(既定 20)。
 * offset は >=0(既定 0)。prefecture_code / city_code は任意。
 *
 * @param input `{ name, prefecture_code?, city_code?, limit?, offset?, include_excluded? }`
 * @returns 検証結果
 */
export function parseSearchParams(input: Record<string, unknown>): SearchParamsResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    return { ok: false, message: "Field 'name' (non-empty string) is required." };
  }

  const rawLimit = toInt(input.limit);
  const limit = rawLimit === undefined
    ? SEARCH_LIMIT_DEFAULT
    : Math.min(SEARCH_LIMIT_MAX, Math.max(1, rawLimit));

  const rawOffset = toInt(input.offset);
  const offset = rawOffset === undefined ? 0 : Math.max(0, rawOffset);

  return {
    ok: true,
    params: {
      name,
      prefectureCode: optionalStr(input.prefecture_code),
      cityCode: optionalStr(input.city_code),
      limit,
      offset,
      includeExcluded: input.include_excluded === true,
    },
  };
}
