import type { CorporationRow } from "@/core/queries";

/**
 * 最小の D1Database モック。
 *
 * SQL は解釈せず、与えた rows をそのまま返す(クエリ文字列の正しさは queries.test.ts で検証)。
 * - `.first<T>()` は rows[0] ?? null
 * - `.all<T>()` は { results: rows }
 *
 * route wiring(503 gate / 404 / 200 整形 / attribution / batch 投入)を検証する用途。
 * `.batch()` は SQL を実行せず、渡された各 statement(prepare→bind 済み)の件数を
 * batches に記録する(投入ループの回数・件数検証用)。
 *
 * @param rows handler が返す行(空配列なら not-found を表現)
 * @returns D1Database 互換のモック + 受け取った (sql, params) の記録
 */
export function mockD1(rows: CorporationRow[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async first<T>(): Promise<T | null> {
              return (rows[0] ?? null) as T | null;
            },
            async all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
              return { results: rows as unknown as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
    async batch<T>(statements: unknown[]): Promise<T[]> {
      batches.push(statements.length);
      return statements.map(() => ({ results: [], success: true, meta: {} })) as unknown as T[];
    },
  };
  return { db: db as unknown as D1Database, calls, batches };
}

/** テスト用のサンプル法人行(law_id は実在の checksum 妥当値)。 */
export const SAMPLE_ROW: CorporationRow = {
  law_id: "1000012160145",
  name: "テスト株式会社",
  name_kana: "テスト",
  name_english: null,
  corp_type: "301",
  prefecture: "東京都",
  city: "千代田区",
  street: "霞が関1-1",
  prefecture_code: "13",
  city_code: "13101",
  postal_code: "1000013",
  assigned_at: "2015-10-05",
  closed_at: null,
  closed_reason: null,
  successor_law_id: null,
  latest: 1,
  search_excluded: 0,
};
