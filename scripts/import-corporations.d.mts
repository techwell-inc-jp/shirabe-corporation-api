/**
 * 型宣言: scripts/import-corporations.mjs(投入 driver)。
 * 純関数は test から型付きで利用するため、公開シグネチャをここで宣言する。
 */

/** record 境界分割の 1 chunk。 */
export interface ImportChunk {
  /** 元 CSV の連続スライス(結合でロスレス復元)。 */
  text: string;
  /** chunk 内の record 数。 */
  records: number;
  /** chunk の UTF-8 バイト長。 */
  bytes: number;
  /** 単一 record が max-bytes を超えた chunk か。 */
  oversized: boolean;
}

/** parseArgs の戻り値。 */
export interface ImportOptions {
  dryRun: boolean;
  maxBytes: number;
  maxRetries: number;
  dir?: string;
  file?: string;
  endpoint?: string;
}

export const DEFAULT_MAX_BYTES: number;

export function recordSpans(text: string): Array<[number, number]>;
export function byteLength(str: string): number;
export function splitIntoChunks(text: string, maxBytes?: number): ImportChunk[];
export function countRecords(text: string): number;
export function parseArgs(argv: string[]): ImportOptions;
export function main(argv: string[]): Promise<void>;
