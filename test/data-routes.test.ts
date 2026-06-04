import { describe, it, expect } from "vitest";
import app from "@/index";
import type {
  ApiError,
  BatchResponse,
  LookupResponse,
  SearchResponse,
} from "@/types";
import type { NormalizeResult } from "@/core/normalize";
import { mockD1, SAMPLE_ROW } from "./helpers/mock-d1";

const VALID_LAW_ID = "1000012160145"; // checksum 妥当(SAMPLE_ROW と一致)
const BAD_CHECKSUM = "2000012160145"; // 形式 OK・checksum 不正

async function post(path: string, body: unknown, env: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/v1/corporation/${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env
  );
}

const ENV_NO_DB = { API_VERSION: "test" };
function envWithRows(rows = [SAMPLE_ROW]) {
  return { API_VERSION: "test", CORP_DB: mockD1(rows).db };
}

describe("POST /lookup", () => {
  it("checksum 不正は 400 INVALID_LAW_ID(D1 を引かない)", async () => {
    for (const id of [BAD_CHECKSUM, "123", 12345]) {
      const res = await post("lookup", { law_id: id }, envWithRows());
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("INVALID_LAW_ID");
    }
  });

  it("D1 未 provisioning は 503 DATA_LAYER_UNAVAILABLE", async () => {
    const res = await post("lookup", { law_id: VALID_LAW_ID }, ENV_NO_DB);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error.code).toBe("DATA_LAYER_UNAVAILABLE");
  });

  it("該当なしは 404 NOT_FOUND", async () => {
    const res = await post("lookup", { law_id: VALID_LAW_ID }, envWithRows([]));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("NOT_FOUND");
  });

  it("該当ありは 200、corporation + attribution を返す", async () => {
    const res = await post("lookup", { law_id: VALID_LAW_ID }, envWithRows());
    expect(res.status).toBe(200);
    const b = (await res.json()) as LookupResponse;
    expect(b.corporation.lawId).toBe(VALID_LAW_ID);
    expect(b.corporation.latest).toBe(true);
    expect(b.attribution.provider).toBe("国税庁");
    expect(b.attribution.modified).toBe(false);
  });
});

describe("POST /search", () => {
  it("name 欠落は 400", async () => {
    const res = await post("search", {}, envWithRows());
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("INVALID_REQUEST");
  });

  it("D1 未 provisioning は 503", async () => {
    const res = await post("search", { name: "トヨタ" }, ENV_NO_DB);
    expect(res.status).toBe(503);
  });

  it("200、結果配列 + count/limit/offset + attribution", async () => {
    const res = await post("search", { name: "テスト", limit: 5, offset: 0 }, envWithRows());
    expect(res.status).toBe(200);
    const b = (await res.json()) as SearchResponse;
    expect(b.results).toHaveLength(1);
    expect(b.results[0]!.name).toBe("テスト株式会社");
    expect(b.count).toBe(1);
    expect(b.limit).toBe(5);
    expect(b.attribution.provider).toBe("国税庁");
  });
});

describe("POST /normalize(データ層不要・常時稼働)", () => {
  it("name 欠落は 400", async () => {
    const res = await post("normalize", {}, ENV_NO_DB);
    expect(res.status).toBe(400);
  });

  it("D1 無しでも 200(純ロジック)", async () => {
    const res = await post("normalize", { name: "㈱テスト" }, ENV_NO_DB);
    expect(res.status).toBe(200);
    const b = (await res.json()) as NormalizeResult;
    expect(b.normalized).toBe("株式会社テスト");
    expect(b.corpType).toBe("株式会社");
  });
});

describe("POST /batch", () => {
  it("空配列 / 非配列は 400", async () => {
    expect((await post("batch", { law_ids: [] }, envWithRows())).status).toBe(400);
    expect((await post("batch", { law_ids: "x" }, envWithRows())).status).toBe(400);
  });

  it("上限超過は 400 BATCH_TOO_LARGE", async () => {
    const many = Array.from({ length: 101 }, () => VALID_LAW_ID);
    const res = await post("batch", { law_ids: many }, envWithRows());
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("BATCH_TOO_LARGE");
  });

  it("D1 未 provisioning は 503", async () => {
    const res = await post("batch", { law_ids: [VALID_LAW_ID] }, ENV_NO_DB);
    expect(res.status).toBe(503);
  });

  it("valid+found と invalid を入力順で返す", async () => {
    const res = await post("batch", { law_ids: [VALID_LAW_ID, BAD_CHECKSUM] }, envWithRows());
    expect(res.status).toBe(200);
    const b = (await res.json()) as BatchResponse;
    expect(b.results).toHaveLength(2);
    expect(b.results[0]).toMatchObject({ lawId: VALID_LAW_ID, valid: true, found: true });
    expect(b.results[0]!.corporation!.name).toBe("テスト株式会社");
    expect(b.results[1]).toMatchObject({ lawId: BAD_CHECKSUM, valid: false, found: false, corporation: null });
    expect(b.attribution.provider).toBe("国税庁");
  });

  it("valid だが registry 不在は found=false", async () => {
    const res = await post("batch", { law_ids: [VALID_LAW_ID] }, envWithRows([]));
    expect(res.status).toBe(200);
    const b = (await res.json()) as BatchResponse;
    expect(b.results[0]).toMatchObject({ valid: true, found: false, corporation: null });
  });
});
