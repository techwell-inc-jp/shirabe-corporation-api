import { describe, it, expect } from "vitest";
import app from "@/index";
import type { ApiError } from "@/types";

const ENV = { API_VERSION: "0.1.0-poc-test" };

describe("corporation API skeleton", () => {
  it("health returns ok with version + data_layer 状態", async () => {
    const res = await app.request("/api/v1/corporation/health", {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      api: string;
      version: string;
      data_layer: string;
    };
    expect(body.status).toBe("ok");
    expect(body.api).toBe("corporation");
    expect(body.version).toBe(ENV.API_VERSION);
    // CORP_DB 未 binding なので unprovisioned
    expect(body.data_layer).toBe("unprovisioned");
  });

  it("データ依存 endpoint は実装済み(501 NOT_IMPLEMENTED ではなく入力検証 400 を返す)", async () => {
    for (const ep of ["lookup", "search", "normalize", "batch"]) {
      const res = await app.request(
        `/api/v1/corporation/${ep}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
        ENV
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiError;
      expect(body.error.code).not.toBe("NOT_IMPLEMENTED");
    }
  });
});
