/**
 * 国税庁 全件 / 日次差分 CSV を D1 `corporations` 表へ投入するための取込層。
 *
 * WS-4(データ投入)の本体。D1 binding(CORP_DB)を直接触らない純粋関数群とし、
 * provisioning 前でも Vitest で完全に test できる(queries.ts / csv-importer.ts と同方針)。
 *
 * 設計:
 *  - CSV は文字レベルの state-machine で tokenize(引用符・エスケープ `""`・
 *    引用符内のカンマ/改行に対応)。行分割では壊れる NTA zenken 形式に堅牢。
 *  - D1 への書き込みは **単一行パラメータ化 upsert**(18 placeholder)を
 *    `db.batch()` で chunk 実行する。多行 INSERT の値インライン化(SQL injection 面 +
 *    エスケープ事故)を避け、5M 行でも安全。
 *  - 取込は「最新履歴のみ保持」(PK=law_id、schema は最新 1 行/社)。差分ファイルの
 *    latest=1 行が既存行を upsert で置換、latest=0(被継承履歴)は保持しない。
 *
 * 出典/列レイアウト: WS-1 実測(knowledge/20260530-corporation-api-ws1-fulldata-measurement.md)。
 */

import { mapRow } from "@/core/csv-importer";
import { CSV_COLUMN_COUNT, type CorporationRecord } from "@/types";
import type { PreparedStatement } from "@/core/queries";

/**
 * 引用符対応 CSV を行(フィールド配列)の列に tokenize する純粋関数。
 *
 * - フィールドは任意で `"` 囲み。囲み内の `""` はリテラル `"`。
 * - フィールド区切りは `,`、レコード区切りは `\n` または `\r\n`(引用符内は無視)。
 * - 末尾改行は空レコードを生まない。空入力は空配列。
 *
 * 行分割(split("\n"))では引用符内改行を含むレコードを壊すため、文字単位で走査する。
 *
 * @param text - CSV 全文(UTF-8、ヘッダ無し)。
 * @returns レコードごとのフィールド文字列配列。
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // 現レコードに 1 文字でも入ったか(末尾空行抑止)

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    records.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // エスケープされた引用符を 1 文字消費
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      pushField();
      started = true;
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // CRLF の CR は無視(LF 側で改行確定)。引用符外の裸 CR も改行とは扱わない。
    } else {
      field += ch;
      started = true;
    }
  }

  // 末尾レコード(改行で閉じられていない最終行)を確定。空行は捨てる。
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }
  return records;
}

/**
 * CSV 全文を CorporationRecord 列に変換する(列数不正な行はスキップ)。
 *
 * 既定で「最新履歴のみ」(latest=1)に絞る。差分取込でも latest=1 行のみ upsert 対象。
 *
 * @param text - NTA CSV 全文。
 * @param opts - `latestOnly`(既定 true)で latest=1 のみ採用。`onError` で不正行を観測。
 * @returns 変換済みレコード配列。
 */
export function recordsFromCsv(
  text: string,
  opts: { latestOnly?: boolean; onError?: (lineIndex: number, error: Error) => void } = {}
): CorporationRecord[] {
  const latestOnly = opts.latestOnly ?? true;
  const out: CorporationRecord[] = [];
  const rows = parseCsvRecords(text);

  for (const [i, cols] of rows.entries()) {
    if (cols.length !== CSV_COLUMN_COUNT) {
      opts.onError?.(i, new Error(`expected ${CSV_COLUMN_COUNT} columns, got ${cols.length}`));
      continue;
    }
    try {
      const record = mapRow(cols);
      if (latestOnly && !record.latest) continue;
      out.push(record);
    } catch (e) {
      opts.onError?.(i, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
}

/**
 * upsert 対象の D1 列(順序は VALUES プレースホルダと一致)。
 * updated_at は取込時刻(運用メタ)を末尾に束縛する。
 */
export const UPSERT_COLUMNS = [
  "law_id",
  "name",
  "name_kana",
  "name_english",
  "corp_type",
  "prefecture",
  "city",
  "street",
  "prefecture_code",
  "city_code",
  "postal_code",
  "assigned_at",
  "closed_at",
  "closed_reason",
  "successor_law_id",
  "latest",
  "search_excluded",
  "updated_at",
] as const;

/** boolean を D1 の 0|1 に変換する。 */
function toInt01(b: boolean): number {
  return b ? 1 : 0;
}

/**
 * 1 法人レコードの冪等 upsert ステートメントを組み立てる。
 *
 * `INSERT ... ON CONFLICT(law_id) DO UPDATE` で再取込・差分上書きを安全にする
 * (同一 law_id は最新値で置換)。値は全て positional placeholder で束縛(インライン化しない)。
 *
 * @param record - 投入する法人レコード。
 * @param importedAt - 取込時刻(ISO 文字列、updated_at に格納)。
 * @returns 準備済みステートメント(18 params)。
 */
export function buildUpsertStatement(
  record: CorporationRecord,
  importedAt: string
): PreparedStatement {
  const placeholders = UPSERT_COLUMNS.map(() => "?").join(", ");
  // law_id は競合キーなので UPDATE からは除外。
  const updateAssignments = UPSERT_COLUMNS.filter((col) => col !== "law_id")
    .map((col) => `${col} = excluded.${col}`)
    .join(", ");

  const sql =
    `INSERT INTO corporations (${UPSERT_COLUMNS.join(", ")}) ` +
    `VALUES (${placeholders}) ` +
    `ON CONFLICT(law_id) DO UPDATE SET ${updateAssignments}`;

  const params: unknown[] = [
    record.lawId,
    record.name,
    record.nameKana,
    record.nameEnglish,
    record.corpType,
    record.prefecture,
    record.city,
    record.street,
    record.prefectureCode,
    record.cityCode,
    record.postalCode,
    record.assignedAt,
    record.closedAt,
    record.closedReason,
    record.successorLawId,
    toInt01(record.latest),
    toInt01(record.searchExcluded),
    importedAt,
  ];
  return { sql, params };
}

/** D1 `db.batch()` 1 回あたりの既定ステートメント数(過大な batch を避ける)。 */
export const DEFAULT_BATCH_SIZE = 1000;

/**
 * 配列を固定長の chunk に分割する純粋関数。
 *
 * @param items - 分割対象。
 * @param size - chunk サイズ(>=1)。
 * @returns chunk の配列。
 * @throws size < 1 の場合。
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * レコード列を batch 実行可能な upsert ステートメントの chunk 列に変換する。
 *
 * 各 chunk を `db.batch(chunk.map(s => db.prepare(s.sql).bind(...s.params)))` で
 * 1 トランザクションとして流す想定(infra 非依存、本関数自体は D1 を触らない)。
 *
 * @param records - 投入レコード。
 * @param importedAt - 取込時刻(ISO)。
 * @param batchSize - chunk サイズ(既定 DEFAULT_BATCH_SIZE)。
 * @returns chunk ごとの PreparedStatement 配列。
 */
export function buildUpsertBatches(
  records: readonly CorporationRecord[],
  importedAt: string,
  batchSize: number = DEFAULT_BATCH_SIZE
): PreparedStatement[][] {
  const statements = records.map((r) => buildUpsertStatement(r, importedAt));
  return chunk(statements, batchSize);
}
