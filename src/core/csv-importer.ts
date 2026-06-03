import { CsvColumn, CSV_COLUMN_COUNT, type CorporationRecord } from "@/types";

/**
 * 空文字列・undefined を null に正規化する。
 *
 * @param v - CSV セル値。
 * @returns 非空なら値、そうでなければ null。
 */
function nullable(v: string | undefined): string | null {
  return v !== undefined && v.length > 0 ? v : null;
}

/**
 * 国税庁 30 列 CSV の 1 行(分割済み配列)を CorporationRecord に変換する純粋関数。
 *
 * 列レイアウトは WS-1 実測(NTA Web-API Ver.4 系 30 列、ヘッダ無し、UTF-8)に準拠。
 *
 * @param cols - 30 要素の文字列配列。
 * @returns 正規化済みレコード。
 * @throws 列数が 30 でない場合。
 */
export function mapRow(cols: readonly string[]): CorporationRecord {
  if (cols.length !== CSV_COLUMN_COUNT) {
    throw new Error(`expected ${CSV_COLUMN_COUNT} columns, got ${cols.length}`);
  }
  return {
    lawId: cols[CsvColumn.LAW_ID] ?? "",
    name: cols[CsvColumn.NAME] ?? "",
    nameKana: nullable(cols[CsvColumn.KANA]),
    nameEnglish: nullable(cols[CsvColumn.NAME_EN]),
    corpType: nullable(cols[CsvColumn.CORP_TYPE]),
    prefecture: nullable(cols[CsvColumn.PREFECTURE]),
    city: nullable(cols[CsvColumn.CITY]),
    street: nullable(cols[CsvColumn.STREET]),
    prefectureCode: nullable(cols[CsvColumn.PREFECTURE_CODE]),
    cityCode: nullable(cols[CsvColumn.CITY_CODE]),
    postalCode: nullable(cols[CsvColumn.POSTAL_CODE]),
    assignedAt: nullable(cols[CsvColumn.ASSIGNED_AT]),
    closedAt: nullable(cols[CsvColumn.CLOSED_AT]),
    closedReason: nullable(cols[CsvColumn.CLOSED_REASON]),
    successorLawId: nullable(cols[CsvColumn.SUCCESSOR_LAW_ID]),
    latest: cols[CsvColumn.LATEST] === "1",
    searchExcluded: cols[CsvColumn.SEARCH_EXCLUDED] === "1",
  };
}

/**
 * 検索・lookup の基本フィルタ。最新履歴のみ + 検索対象除外を除く。
 * WS-1 §5: 基本 WHERE 条件 `最新履歴=1 AND 検索対象除外=0`。
 *
 * @param record - 判定対象レコード。
 * @returns 検索・公開対象なら true。
 */
export function isActiveSearchable(record: CorporationRecord): boolean {
  return record.latest && !record.searchExcluded;
}
