import { describe, it, expect } from "vitest";
import {
  BATCH_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  buildBatchLookupStatement,
  buildLookupStatement,
  buildSearchStatement,
  mapRowToRecord,
  parseSearchParams,
} from "@/core/queries";
import { SAMPLE_ROW } from "./helpers/mock-d1";

describe("buildLookupStatement", () => {
  it("最新履歴のみ・1 件の SQL を返す", () => {
    const { sql, params } = buildLookupStatement("1000012160145");
    expect(sql).toContain("law_id = ?");
    expect(sql).toContain("latest = 1");
    expect(sql).toContain("LIMIT 1");
    expect(params).toEqual(["1000012160145"]);
  });
});

describe("buildSearchStatement", () => {
  it("name 前方一致 + active filter + ページングをパラメータ順に並べる", () => {
    const { sql, params } = buildSearchStatement({ name: "トヨタ", limit: 20, offset: 0 });
    expect(sql).toContain("name LIKE ? ESCAPE '\\'");
    expect(sql).toContain("search_excluded = 0");
    expect(sql).toContain("ORDER BY name LIMIT ? OFFSET ?");
    expect(params).toEqual(["トヨタ%", 20, 0]);
  });

  it("LIKE メタ文字(% _ \\)を escape する", () => {
    const { params } = buildSearchStatement({ name: "100%_株\\", limit: 10, offset: 0 });
    expect(params[0]).toBe("100\\%\\_株\\\\%");
  });

  it("prefecture/city フィルタを WHERE と params に順序通り追加する", () => {
    const { sql, params } = buildSearchStatement({
      name: "山田",
      prefectureCode: "13",
      cityCode: "13101",
      limit: 5,
      offset: 10,
    });
    expect(sql).toContain("prefecture_code = ?");
    expect(sql).toContain("city_code = ?");
    expect(params).toEqual(["山田%", "13", "13101", 5, 10]);
  });

  it("includeExcluded=true で search_excluded フィルタを外す", () => {
    const { sql } = buildSearchStatement({ name: "x", limit: 1, offset: 0, includeExcluded: true });
    expect(sql).not.toContain("search_excluded");
  });
});

describe("parseSearchParams", () => {
  it("name 必須(空は ok=false)", () => {
    expect(parseSearchParams({ name: "  " }).ok).toBe(false);
    expect(parseSearchParams({}).ok).toBe(false);
  });

  it("既定 limit/offset", () => {
    const r = parseSearchParams({ name: "トヨタ" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.limit).toBe(SEARCH_LIMIT_DEFAULT);
      expect(r.params.offset).toBe(0);
    }
  });

  it("limit を 1..MAX にクランプ", () => {
    const hi = parseSearchParams({ name: "x", limit: 9999 });
    const lo = parseSearchParams({ name: "x", limit: 0 });
    expect(hi.ok && hi.params.limit).toBe(SEARCH_LIMIT_MAX);
    expect(lo.ok && lo.params.limit).toBe(1);
  });

  it("offset 負値は 0、文字列数値も受理", () => {
    const neg = parseSearchParams({ name: "x", offset: -5 });
    const str = parseSearchParams({ name: "x", limit: "30", offset: "40" });
    expect(neg.ok && neg.params.offset).toBe(0);
    expect(str.ok && str.params.limit).toBe(30);
    expect(str.ok && str.params.offset).toBe(40);
  });

  it("空文字フィルタは undefined 化", () => {
    const r = parseSearchParams({ name: "x", prefecture_code: "", city_code: "13101" });
    expect(r.ok && r.params.prefectureCode).toBeUndefined();
    expect(r.ok && r.params.cityCode).toBe("13101");
  });
});

describe("buildBatchLookupStatement", () => {
  it("IN プレースホルダ数 = id 数", () => {
    const { sql, params } = buildBatchLookupStatement(["1", "2", "3"]);
    expect(sql).toContain("law_id IN (?, ?, ?)");
    expect(sql).toContain("latest = 1");
    expect(params).toEqual(["1", "2", "3"]);
  });

  it("BATCH_MAX は 100", () => {
    expect(BATCH_MAX).toBe(100);
  });
});

describe("mapRowToRecord", () => {
  it("snake_case 行 → CorporationRecord、0|1 → boolean", () => {
    const rec = mapRowToRecord(SAMPLE_ROW);
    expect(rec.lawId).toBe("1000012160145");
    expect(rec.name).toBe("テスト株式会社");
    expect(rec.nameKana).toBe("テスト");
    expect(rec.nameEnglish).toBeNull();
    expect(rec.prefectureCode).toBe("13");
    expect(rec.latest).toBe(true);
    expect(rec.searchExcluded).toBe(false);
  });

  it("latest=0 / search_excluded=1 を反映", () => {
    const rec = mapRowToRecord({ ...SAMPLE_ROW, latest: 0, search_excluded: 1 });
    expect(rec.latest).toBe(false);
    expect(rec.searchExcluded).toBe(true);
  });
});
