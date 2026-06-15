import { describe, it, expect } from "vitest";
import {
  parseCsvRecords,
  recordsFromCsv,
  buildUpsertStatement,
  buildUpsertBatches,
  UPSERT_COLUMNS,
  chunk,
} from "@/core/bulk-import";
import { mapRow } from "@/core/csv-importer";
import { CSV_COLUMN_COUNT, CsvColumn } from "@/types";

/** WS-1 サンプルを 30 列配置した行を生成する(csv-importer.test と同形)。 */
function sampleCols(overrides: Partial<Record<number, string>> = {}): string[] {
  const cols = new Array<string>(CSV_COLUMN_COUNT).fill("");
  cols[CsvColumn.SEQUENCE] = "1";
  cols[CsvColumn.LAW_ID] = "1000012160145";
  cols[CsvColumn.NAME] = "弘前検察審査会";
  cols[CsvColumn.CORP_TYPE] = "101";
  cols[CsvColumn.PREFECTURE] = "青森県";
  cols[CsvColumn.CITY] = "弘前市";
  cols[CsvColumn.STREET] = "大字下白銀町７";
  cols[CsvColumn.PREFECTURE_CODE] = "02";
  cols[CsvColumn.CITY_CODE] = "02202";
  cols[CsvColumn.POSTAL_CODE] = "0368356";
  cols[CsvColumn.ASSIGNED_AT] = "2015-10-05";
  cols[CsvColumn.LATEST] = "1";
  cols[CsvColumn.NAME_EN] = "Hirosaki Committee";
  cols[CsvColumn.KANA] = "ヒロサキケンサツシンサカイ";
  cols[CsvColumn.SEARCH_EXCLUDED] = "0";
  for (const [k, v] of Object.entries(overrides)) cols[Number(k)] = v ?? "";
  return cols;
}

/** フィールド配列を二重引用符囲みの CSV 行にする(NTA zenken 形式)。 */
function toCsvLine(cols: readonly string[]): string {
  return cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

describe("parseCsvRecords", () => {
  it("parses a simple unquoted record", () => {
    expect(parseCsvRecords("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("handles quoted fields containing commas", () => {
    expect(parseCsvRecords('"a,1","b","c"')).toEqual([["a,1", "b", "c"]]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsvRecords('"he said ""hi""","x"')).toEqual([['he said "hi"', "x"]]);
  });

  it("keeps embedded newlines inside quotes as one record", () => {
    expect(parseCsvRecords('"line1\nline2","b"')).toEqual([["line1\nline2", "b"]]);
  });

  it("splits records on CRLF and ignores a trailing newline", () => {
    expect(parseCsvRecords('"a","b"\r\n"c","d"\r\n')).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseCsvRecords("")).toEqual([]);
  });

  it("preserves empty fields", () => {
    expect(parseCsvRecords('"a","","c"')).toEqual([["a", "", "c"]]);
  });

  it("round-trips a full 30-column NTA line", () => {
    const cols = sampleCols();
    const parsed = parseCsvRecords(toCsvLine(cols));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(CSV_COLUMN_COUNT);
    expect(parsed[0]![CsvColumn.NAME]).toBe("弘前検察審査会");
  });
});

describe("recordsFromCsv", () => {
  it("maps valid rows to records", () => {
    const text = toCsvLine(sampleCols()) + "\r\n" + toCsvLine(sampleCols({ [CsvColumn.LAW_ID]: "2000012160144" }));
    const records = recordsFromCsv(text);
    expect(records).toHaveLength(2);
    expect(records[0]!.lawId).toBe("1000012160145");
  });

  it("filters out non-latest history rows by default", () => {
    const text =
      toCsvLine(sampleCols()) +
      "\n" +
      toCsvLine(sampleCols({ [CsvColumn.LAW_ID]: "9000012160141", [CsvColumn.LATEST]: "0" }));
    const records = recordsFromCsv(text);
    expect(records).toHaveLength(1);
    expect(records[0]!.lawId).toBe("1000012160145");
  });

  it("includes non-latest rows when latestOnly=false", () => {
    const text = toCsvLine(sampleCols({ [CsvColumn.LATEST]: "0" }));
    expect(recordsFromCsv(text, { latestOnly: false })).toHaveLength(1);
  });

  it("reports rows with a wrong column count via onError and skips them", () => {
    const errors: number[] = [];
    const text = '"a","b","c"\n' + toCsvLine(sampleCols());
    const records = recordsFromCsv(text, { onError: (i) => errors.push(i) });
    expect(records).toHaveLength(1);
    expect(errors).toEqual([0]);
  });
});

describe("buildUpsertStatement", () => {
  const record = mapRow(sampleCols());
  const stmt = buildUpsertStatement(record, "2026-06-15T00:00:00Z");

  it("is an idempotent INSERT ... ON CONFLICT upsert", () => {
    expect(stmt.sql).toContain("INSERT INTO corporations");
    expect(stmt.sql).toContain("ON CONFLICT(law_id) DO UPDATE SET");
  });

  it("binds exactly one parameter per upsert column", () => {
    expect(stmt.params).toHaveLength(UPSERT_COLUMNS.length);
    expect(UPSERT_COLUMNS).toHaveLength(18);
  });

  it("encodes booleans as 0/1 and puts importedAt last", () => {
    expect(stmt.params[0]).toBe("1000012160145"); // law_id first
    expect(stmt.params[15]).toBe(1); // latest
    expect(stmt.params[16]).toBe(0); // search_excluded
    expect(stmt.params[17]).toBe("2026-06-15T00:00:00Z"); // updated_at last
  });

  it("excludes the conflict key (law_id) from the UPDATE clause", () => {
    expect(stmt.sql).not.toContain("law_id = excluded.law_id");
    expect(stmt.sql).toContain("name = excluded.name");
  });

  it("preserves null for empty optional fields", () => {
    const r = mapRow(sampleCols({ [CsvColumn.CLOSED_AT]: "" }));
    const s = buildUpsertStatement(r, "t");
    expect(s.params[12]).toBeNull(); // closed_at
  });
});

describe("chunk", () => {
  it("splits into fixed-size groups with a remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns empty for empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("throws on size < 1", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("buildUpsertBatches", () => {
  it("chunks statements by batch size", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      mapRow(sampleCols({ [CsvColumn.LAW_ID]: `100001216014${i}` }))
    );
    const batches = buildUpsertBatches(records, "t", 2);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batches[0]![0]!.sql).toContain("INSERT INTO corporations");
  });
});
