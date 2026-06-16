import { describe, it, expect } from "vitest";
import {
  recordSpans,
  splitIntoChunks,
  countRecords,
  byteLength,
  parseArgs,
  DEFAULT_MAX_BYTES,
} from "../scripts/import-corporations.mjs";

/** splitIntoChunks の要素型(.mjs は untyped のため test 側で明示)。 */
type Chunk = { text: string; records: number; bytes: number; oversized: boolean };

/**
 * 投入 driver の純関数(record 境界分割)テスト。
 *
 * 最重要不変条件:
 *  1) 引用符内の改行で record を切らない(国税庁 CSV の引用符付き商号に頻出)。
 *  2) chunk を結合すると元 CSV に完全一致(ロスレス分割)。
 *  3) 各 chunk は max-bytes 以下(単一 record 超過の oversized を除く)。
 */
describe("recordSpans", () => {
  it("引用符外の改行で record を分割する", () => {
    const text = "1,a\n2,b\n3,c\n";
    expect(recordSpans(text).length).toBe(3);
    expect(countRecords(text)).toBe(3);
  });

  it("引用符内の改行では分割しない", () => {
    // フィールド "x\ny" の中の改行は record 境界ではない。
    const text = '1,"x\ny",z\n2,p,q\n';
    expect(countRecords(text)).toBe(2);
  });

  it("エスケープされた引用符 \"\" を 1 record 内に保つ", () => {
    const text = '1,"a""b",c\n2,d,e\n';
    expect(countRecords(text)).toBe(2);
  });

  it("末尾改行なしの最終 record も数える", () => {
    expect(countRecords("1,a\n2,b")).toBe(2);
  });

  it("空入力は 0 record", () => {
    expect(countRecords("")).toBe(0);
  });

  it("CRLF を LF と同様に扱う", () => {
    expect(countRecords("1,a\r\n2,b\r\n")).toBe(2);
  });
});

describe("splitIntoChunks", () => {
  it("結合すると元テキストに完全一致する(ロスレス)", () => {
    const text = "1,aaaa\n2,bbbb\n3,cccc\n4,dddd\n";
    const chunks: Chunk[] = splitIntoChunks(text, 10);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("各 chunk は max-bytes 以下(oversized record を除く)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i},row-${i}`).join("\n") + "\n";
    const max = 40;
    const chunks: Chunk[] = splitIntoChunks(text, max);
    for (const c of chunks) {
      if (!c.oversized) expect(c.bytes).toBeLessThanOrEqual(max);
    }
    // record 総数は保存される。
    const total = chunks.reduce((a, c) => a + c.records, 0);
    expect(total).toBe(countRecords(text));
  });

  it("引用符内の改行を含む record を境界跨ぎで分割しない", () => {
    const text = '1,"line1\nline2\nline3",end\n2,short,x\n';
    // 1 record 目に改行 2 つあるが分割しても record は壊れない。
    const chunks: Chunk[] = splitIntoChunks(text, 8);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    const total = chunks.reduce((a, c) => a + c.records, 0);
    expect(total).toBe(2);
  });

  it("単一 record が max-bytes 超なら oversized 単独 chunk にする", () => {
    const big = "x".repeat(100);
    const text = `1,${big}\n2,small\n`;
    const chunks: Chunk[] = splitIntoChunks(text, 20);
    const oversized = chunks.filter((c) => c.oversized);
    expect(oversized.length).toBe(1);
    expect(oversized[0]?.records).toBe(1);
    // ロスレスは維持。
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("マルチバイト(UTF-8)を byte で正しく測る", () => {
    // 日本語 1 文字 = 3 bytes。
    const text = "1,株式会社テックウェル\n2,有限会社サンプル\n";
    expect(byteLength(text)).toBeGreaterThan(text.length); // multibyte
    const chunks: Chunk[] = splitIntoChunks(text, 30);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });
});

describe("parseArgs", () => {
  it("既定値(dry-run=false, max-bytes=DEFAULT)", () => {
    const o = parseArgs([]);
    expect(o.dryRun).toBe(false);
    expect(o.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(o.maxRetries).toBe(3);
  });

  it("--dir --dry-run --max-bytes を解釈する", () => {
    const o = parseArgs(["--dir", "./csv", "--dry-run", "--max-bytes", "1024"]);
    expect(o.dir).toBe("./csv");
    expect(o.dryRun).toBe(true);
    expect(o.maxBytes).toBe(1024);
  });

  it("未知引数は例外", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});
