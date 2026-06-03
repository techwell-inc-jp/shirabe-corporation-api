import { describe, it, expect } from "vitest";
import { computeCheckDigit, isValidLawId, isWellFormedLawId } from "@/core/checksum";

// WS-1 実測の実在法人番号(弘前検察審査会、青森 全件 CSV row[0])。
const REAL_LAW_ID = "1000012160145";

describe("法人番号 checksum (mod 9)", () => {
  it("computes the check digit of a real 法人番号", () => {
    expect(computeCheckDigit(REAL_LAW_ID.slice(1))).toBe(Number(REAL_LAW_ID[0]));
  });

  it("validates a real 法人番号", () => {
    expect(isValidLawId(REAL_LAW_ID)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    // 正しい先頭桁は 1。2 に差し替えると不一致。
    expect(isValidLawId("2" + REAL_LAW_ID.slice(1))).toBe(false);
  });

  it("rejects malformed inputs", () => {
    expect(isValidLawId("123")).toBe(false);
    expect(isValidLawId("100001216014X")).toBe(false);
    expect(isValidLawId("")).toBe(false);
  });

  it("isWellFormedLawId checks 13-digit shape only", () => {
    expect(isWellFormedLawId("1000012160145")).toBe(true);
    expect(isWellFormedLawId("100")).toBe(false);
    expect(isWellFormedLawId("100001216014X")).toBe(false);
  });

  it("round-trips computed check digits", () => {
    for (const base of ["000012160145", "123456789012", "000000000001"]) {
      const cd = computeCheckDigit(base);
      expect(isValidLawId(`${cd}${base}`)).toBe(true);
    }
  });

  it("throws on a non-12-digit base", () => {
    expect(() => computeCheckDigit("123")).toThrow();
    expect(() => computeCheckDigit("00001216014X")).toThrow();
  });
});
