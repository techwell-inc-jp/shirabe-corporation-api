import { describe, it, expect } from "vitest";
import { normalizeCorporationName } from "@/core/normalize";

describe("normalizeCorporationName", () => {
  it("㈱(前置)を株式会社に展開し、種別を分離する", () => {
    const r = normalizeCorporationName("㈱テスト");
    expect(r.normalized).toBe("株式会社テスト");
    expect(r.corpType).toBe("株式会社");
    expect(r.corpTypePosition).toBe("prefix");
    expect(r.baseName).toBe("テスト");
  });

  it("㈲(後置)を有限会社に展開する", () => {
    const r = normalizeCorporationName("テスト㈲");
    expect(r.normalized).toBe("テスト有限会社");
    expect(r.corpType).toBe("有限会社");
    expect(r.corpTypePosition).toBe("suffix");
    expect(r.baseName).toBe("テスト");
  });

  it("全角英数字を半角化(NFKC)し、後置種別を分離する", () => {
    const r = normalizeCorporationName("ＡＢＣ株式会社");
    expect(r.normalized).toBe("ABC株式会社");
    expect(r.corpType).toBe("株式会社");
    expect(r.corpTypePosition).toBe("suffix");
    expect(r.baseName).toBe("ABC");
  });

  it("半角カナを全角化する(NFKC)", () => {
    const r = normalizeCorporationName("ﾄﾖﾀ自動車");
    expect(r.normalized).toBe("トヨタ自動車");
    expect(r.corpType).toBeNull();
    expect(r.baseName).toBe("トヨタ自動車");
  });

  it("全角空白を含む連続空白を単一スペース化し trim する", () => {
    const r = normalizeCorporationName("  山田　商店  ");
    expect(r.normalized).toBe("山田 商店");
  });

  it("長い種別語を優先する(一般社団法人 > 社団法人)", () => {
    const r = normalizeCorporationName("一般社団法人日本データ協会");
    expect(r.corpType).toBe("一般社団法人");
    expect(r.corpTypePosition).toBe("prefix");
    expect(r.baseName).toBe("日本データ協会");
  });

  it("種別語が無ければ corpType=null、baseName=normalized", () => {
    const r = normalizeCorporationName("トヨタ自動車");
    expect(r.corpType).toBeNull();
    expect(r.corpTypePosition).toBeNull();
    expect(r.baseName).toBe("トヨタ自動車");
  });

  it("input は無加工で保持する", () => {
    const r = normalizeCorporationName("㈱テスト");
    expect(r.input).toBe("㈱テスト");
  });
});
