/**
 * 法人データ投入 driver(WS-4)。
 *
 * 国税庁 全件 / 日次差分 CSV(都道府県別、ヘッダ無し・UTF-8)を
 * admin import endpoint(`POST /api/v1/corporation/admin/import`)へ順次 POST する。
 *
 * ★ なぜ分割が必須か:
 *   admin endpoint は `c.req.text()` で body 全文をメモリに展開し、
 *   全 record + 全 upsert statement を同時に保持する。Cloudflare Workers は
 *   1 リクエスト 128MB メモリ + リクエストボディ上限(plan により 100MB 程度)のため、
 *   大規模県(例: 東京)の県別ファイルをそのまま 1 POST すると OOM / 413 になる。
 *   本 driver は **record 境界(引用符内改行を壊さない)で max-bytes 以下の chunk に
 *   分割**してから POST する。chunk 投入は upsert 冪等なので再実行・中断再開が安全。
 *
 * 取込ロジック本体(tokenize / upsert / latest 履歴フィルタ)は server 側
 * `src/core/bulk-import.ts`(テスト済み)。本 driver はファイル走査・安全分割・POST のみ。
 *
 * 使い方:
 *   # dry-run(POST しない。各ファイルのサイズ・推定 record 数・分割 chunk 数を出す)
 *   node scripts/import-corporations.mjs --dir ./nta-csv --dry-run
 *
 *   # 本投入(ADMIN_IMPORT_TOKEN は環境変数で渡す。平文を引数に書かない)
 *   ADMIN_IMPORT_TOKEN=*** node scripts/import-corporations.mjs \
 *     --dir ./nta-csv --endpoint https://shirabe.dev/api/v1/corporation/admin/import
 *
 * オプション:
 *   --dir <path>        CSV ファイルを含むディレクトリ(*.csv を名前昇順=県コード順に処理)
 *   --file <path>       単一ファイルのみ処理(--dir と排他)
 *   --endpoint <url>    admin import endpoint(本投入時必須)
 *   --max-bytes <n>     1 chunk の最大バイト数(既定 8388608 = 8MiB、安全側)
 *   --dry-run           POST せず計測のみ
 *   --max-retries <n>   POST 失敗時のリトライ回数(既定 3)
 *
 * 認証トークンは環境変数 ADMIN_IMPORT_TOKEN からのみ読む(ログに出力しない)。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

/** 1 chunk の既定最大バイト数(8 MiB)。Workers メモリ/ボディ上限に対する安全マージン。 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * CSV テキストを record(行)境界の char index 配列に分解する純関数。
 *
 * bulk-import.ts の parseCsvRecords と同じ引用符状態機械:
 *  - `"` で囲まれたフィールド内の `,` `\n` は区切りと見なさない。
 *  - 囲み内の `""` はリテラル `"`(2 文字消費)。
 *  - レコード区切りは引用符外の `\n`(直前 `\r` は無視 = CRLF 対応)。
 *
 * @param {string} text CSV 全文(UTF-8、ヘッダ無し)。
 * @returns {Array<[number, number]>} 各 record の [startCharIndex, endCharIndex)。
 *   endCharIndex は末尾の `\n` を含む(分割時にロスなく結合できる)。空 record は含めない。
 */
export function recordSpans(text) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let start = 0;
  let inQuotes = false;
  let hasContent = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++; // エスケープされた引用符を消費
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === "\n") {
      // [start, i] を 1 record として確定(末尾 \n を含める)。
      spans.push([start, i + 1]);
      start = i + 1;
      hasContent = false;
    } else if (ch === "\r") {
      // CRLF の CR は無視(LF 側で確定)。
    } else {
      hasContent = true;
    }
  }
  // 改行で閉じられていない最終 record。
  if (hasContent || start < text.length) {
    if (start < text.length) spans.push([start, text.length]);
  }
  return spans;
}

/** UTF-8 バイト長(マルチバイト安全)。 */
export function byteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

/**
 * CSV を record 境界で maxBytes 以下の chunk に貪欲分割する純関数。
 *
 * 各 chunk は元テキストの連続スライス(record 境界で切る)なので、結合すると元に戻る。
 * 単一 record が maxBytes を超える場合は、その record 単独の chunk を warn 付きで返す
 * (server 側 tokenizer は壊れない。POST 時の上限超過は呼出側が判断)。
 *
 * @param {string} text CSV 全文。
 * @param {number} maxBytes 1 chunk の最大バイト数。
 * @returns {Array<{ text: string, records: number, bytes: number, oversized: boolean }>}
 */
export function splitIntoChunks(text, maxBytes = DEFAULT_MAX_BYTES) {
  const spans = recordSpans(text);
  const chunks = [];
  let curStart = -1;
  let curEnd = -1;
  let curBytes = 0;
  let curRecords = 0;

  const flush = (oversized = false) => {
    if (curStart < 0) return;
    const slice = text.slice(curStart, curEnd);
    chunks.push({ text: slice, records: curRecords, bytes: byteLength(slice), oversized });
    curStart = -1;
    curEnd = -1;
    curBytes = 0;
    curRecords = 0;
  };

  for (const [s, e] of spans) {
    const recBytes = byteLength(text.slice(s, e));
    if (recBytes > maxBytes) {
      // 単一 record が上限超過 → 現 chunk を出してから単独 chunk(oversized)で出す。
      flush();
      chunks.push({ text: text.slice(s, e), records: 1, bytes: recBytes, oversized: true });
      continue;
    }
    if (curStart >= 0 && curBytes + recBytes > maxBytes) {
      flush(); // 現 chunk に足すと超える → 先に flush
    }
    if (curStart < 0) curStart = s;
    curEnd = e;
    curBytes += recBytes;
    curRecords += 1;
  }
  flush();
  return chunks;
}

/** record(行)数を数える(dry-run 表示用)。 */
export function countRecords(text) {
  return recordSpans(text).length;
}

/** argv を最小パース(--key value / --flag)。 */
export function parseArgs(argv) {
  const out = { dryRun: false, maxBytes: DEFAULT_MAX_BYTES, maxRetries: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
    else if (a === "--max-bytes") out.maxBytes = Number(argv[++i]);
    else if (a === "--max-retries") out.maxRetries = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** 処理対象ファイル一覧を名前昇順(=県コード順)で返す。 */
function listFiles(opts) {
  if (opts.file) return [opts.file];
  if (!opts.dir) throw new Error("--dir または --file が必要です");
  return readdirSync(opts.dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort()
    .map((f) => join(opts.dir, f));
}

/** バイト数を人間可読化。 */
function human(bytes) {
  const u = ["B", "KiB", "MiB", "GiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

/** 1 chunk を POST(リトライ付き、冪等 upsert 前提)。token はログに出さない。 */
async function postChunk(endpoint, token, chunkText, maxRetries) {
  let lastErr = "";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "X-Admin-Token": token, "Content-Type": "text/csv; charset=utf-8" },
        body: chunkText,
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // 4xx は再試行しても無駄(401/400/413)。即座に投げる。
      if (res.status < 500) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (lastErr.startsWith("HTTP 4")) throw e; // 4xx は再試行しない
    }
    if (attempt < maxRetries) {
      const backoff = 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`POST failed after ${maxRetries} attempts: ${lastErr}`);
}

/** CLI 本体。 */
export async function main(argv) {
  const opts = parseArgs(argv);
  const files = listFiles(opts);
  if (files.length === 0) {
    console.error("対象 CSV が見つかりません。");
    process.exitCode = 1;
    return;
  }

  const token = process.env.ADMIN_IMPORT_TOKEN;
  if (!opts.dryRun) {
    if (!opts.endpoint) throw new Error("本投入には --endpoint が必要です(dry-run は --dry-run)");
    if (!token) throw new Error("環境変数 ADMIN_IMPORT_TOKEN が未設定です");
  }

  console.log(
    `${opts.dryRun ? "[DRY-RUN] " : ""}files=${files.length} max-bytes=${human(opts.maxBytes)}`
  );

  let totalRecords = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  let oversizedFiles = 0;
  let importedSum = 0;
  let skippedSum = 0;

  for (const path of files) {
    const name = basename(path);
    const sizeBytes = statSync(path).size;
    const text = readFileSync(path, "utf8");
    const chunks = splitIntoChunks(text, opts.maxBytes);
    const records = chunks.reduce((a, c) => a + c.records, 0);
    const hasOversized = chunks.some((c) => c.oversized);
    totalRecords += records;
    totalChunks += chunks.length;
    totalBytes += sizeBytes;
    if (hasOversized) oversizedFiles++;

    const flag = hasOversized ? "  ⚠ oversized-record(単一 record が max-bytes 超)" : "";
    console.log(
      `  ${name}: ${human(sizeBytes)} / ~${records} records / ${chunks.length} chunk(s)${flag}`
    );

    if (opts.dryRun) continue;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const result = await postChunk(opts.endpoint, token, c.text, opts.maxRetries);
      importedSum += result.imported ?? 0;
      skippedSum += result.skipped ?? 0;
      console.log(
        `    chunk ${i + 1}/${chunks.length} (${human(c.bytes)}): ` +
          `imported=${result.imported} skipped=${result.skipped} batches=${result.batches}`
      );
    }
  }

  console.log("---");
  console.log(
    `合計: files=${files.length} records≈${totalRecords} chunks=${totalChunks} ` +
      `size=${human(totalBytes)}` + (oversizedFiles ? ` oversized-files=${oversizedFiles}` : "")
  );
  if (!opts.dryRun) {
    console.log(`投入: imported=${importedSum} skipped=${skippedSum}`);
  } else {
    console.log("dry-run のため POST はしていません。--endpoint + ADMIN_IMPORT_TOKEN で本投入。");
  }
}

// main-guard: import 時は実行しない(テストから純関数を読むため。
// memory reference_assets_mjs_scripts_run_main_on_import の轍を踏まない)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
