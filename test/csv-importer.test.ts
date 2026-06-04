import { describe, it, expect } from "vitest";
import { mapRow, isActiveSearchable } from "@/core/csv-importer";
import { CSV_COLUMN_COUNT, CsvColumn } from "@/types";

/** WS-1 サンプル(弘前検察審査会)を 30 列に正しく配置した行を生成する。 */
function sampleRow(): string[] {
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
  cols[CsvColumn.NAME_EN] = "Hirosaki Committee for the Inquest of Prosecution";
  cols[CsvColumn.KANA] = "ヒロサキケンサツシンサカイ";
  cols[CsvColumn.SEARCH_EXCLUDED] = "0";
  return cols;
}

describe("csv-importer mapRow", () => {
  it("maps the WS-1 sample row to a normalized record", () => {
    const r = mapRow(sampleRow());
    expect(r.lawId).toBe("1000012160145");
    expect(r.name).toBe("弘前検察審査会");
    expect(r.nameKana).toBe("ヒロサキケンサツシンサカイ");
    expect(r.nameEnglish).toContain("Hirosaki");
    expect(r.prefecture).toBe("青森県");
    expect(r.prefectureCode).toBe("02");
    expect(r.cityCode).toBe("02202");
    expect(r.postalCode).toBe("0368356");
    expect(r.latest).toBe(true);
    expect(r.searchExcluded).toBe(false);
  });

  it("normalizes empty strings to null", () => {
    const r = mapRow(sampleRow());
    expect(r.closedAt).toBeNull();
    expect(r.closedReason).toBeNull();
    expect(r.successorLawId).toBeNull();
  });

  it("throws on a wrong column count", () => {
    expect(() => mapRow(["1", "2", "3"])).toThrow();
  });
});

describe("isActiveSearchable", () => {
  it("true when latest && !searchExcluded", () => {
    expect(isActiveSearchable(mapRow(sampleRow()))).toBe(true);
  });

  it("false when search-excluded", () => {
    const cols = sampleRow();
    cols[CsvColumn.SEARCH_EXCLUDED] = "1";
    expect(isActiveSearchable(mapRow(cols))).toBe(false);
  });

  it("false when not the latest history row", () => {
    const cols = sampleRow();
    cols[CsvColumn.LATEST] = "0";
    expect(isActiveSearchable(mapRow(cols))).toBe(false);
  });
});
