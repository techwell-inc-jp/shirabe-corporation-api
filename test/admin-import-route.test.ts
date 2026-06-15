import { describe, it, expect } from "vitest";
import app from "@/index";
import type { AdminImportResponse, ApiError } from "@/types";
import { CSV_COLUMN_COUNT, CsvColumn } from "@/types";
import { mockD1 } from "./helpers/mock-d1";

const TOKEN = "test-admin-token";

/** 30 列の二重引用符囲み CSV 行を作る。 */
function csvLine(overrides: Partial<Record<number, string>>): string {
  const cols = new Array<string>(CSV_COLUMN_COUNT).fill("");
  cols[CsvColumn.SEQUENCE] = "1";
  cols[CsvColumn.LATEST] = "1";
  cols[CsvColumn.SEARCH_EXCLUDED] = "0";
  for (const [k, v] of Object.entries(overrides)) cols[Number(k)] = v ?? "";
  return cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

async function postImport(body: string, env: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "text/csv" };
  if (token !== undefined) headers["X-Admin-Token"] = token;
  return app.request("/api/v1/corporation/admin/import", { method: "POST", headers, body }, env);
}

const VALID_CSV =
  csvLine({ [CsvColumn.LAW_ID]: "1000012160145", [CsvColumn.NAME]: "テスト株式会社" }) +
  "\r\n" +
  csvLine({ [CsvColumn.LAW_ID]: "2000012160144", [CsvColumn.NAME]: "別法人" });

describe("POST /admin/import — auth gate", () => {
  it("503 ADMIN_DISABLED when ADMIN_IMPORT_TOKEN is not set", async () => {
    const res = await postImport(VALID_CSV, { API_VERSION: "test", CORP_DB: mockD1([]).db }, TOKEN);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error.code).toBe("ADMIN_DISABLED");
  });

  it("401 when token missing", async () => {
    const res = await postImport(VALID_CSV, { API_VERSION: "test", ADMIN_IMPORT_TOKEN: TOKEN, CORP_DB: mockD1([]).db });
    expect(res.status).toBe(401);
  });

  it("401 when token wrong", async () => {
    const res = await postImport(VALID_CSV, { API_VERSION: "test", ADMIN_IMPORT_TOKEN: TOKEN, CORP_DB: mockD1([]).db }, "wrong");
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/import — data layer + payload", () => {
  it("503 DATA_LAYER_UNAVAILABLE when CORP_DB unprovisioned", async () => {
    const res = await postImport(VALID_CSV, { API_VERSION: "test", ADMIN_IMPORT_TOKEN: TOKEN }, TOKEN);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error.code).toBe("DATA_LAYER_UNAVAILABLE");
  });

  it("400 on empty body", async () => {
    const res = await postImport("   ", { API_VERSION: "test", ADMIN_IMPORT_TOKEN: TOKEN, CORP_DB: mockD1([]).db }, TOKEN);
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/import — successful upsert", () => {
  it("imports latest rows, skips malformed, runs batches", async () => {
    const m = mockD1([]);
    const body =
      VALID_CSV +
      "\r\n" +
      csvLine({ [CsvColumn.LAW_ID]: "9000012160141", [CsvColumn.LATEST]: "0" }) + // non-latest → filtered
      "\r\n" +
      '"too","few","cols"'; // wrong column count → skipped
    const res = await postImport(body, { API_VERSION: "test", ADMIN_IMPORT_TOKEN: TOKEN, CORP_DB: m.db }, TOKEN);
    expect(res.status).toBe(200);
    const b = (await res.json()) as AdminImportResponse;
    expect(b.imported).toBe(2); // 2 latest rows
    expect(b.skipped).toBe(1); // malformed row
    expect(b.batches).toBe(1);
    expect(typeof b.importedAt).toBe("string");
    // upsert SQL が実際に bind された
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.sql).toContain("ON CONFLICT(law_id) DO UPDATE");
    expect(m.batches).toEqual([2]); // 1 batch, 2 statements
  });
});
