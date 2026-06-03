import { describe, it, expect } from "vitest";
import app from "@/index";
import type { ApiError, ValidateResult } from "@/types";

const ENV = { API_VERSION: "0.1.0-poc-test" };

async function postValidate(body: unknown): Promise<Response> {
  return app.request(
    "/api/v1/corporation/validate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV
  );
}

describe("POST /api/v1/corporation/validate", () => {
  it("returns valid=true for a real 法人番号", async () => {
    const res = await postValidate({ law_id: "1000012160145" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as ValidateResult;
    expect(b.formatValid).toBe(true);
    expect(b.checksumValid).toBe(true);
    expect(b.valid).toBe(true);
    expect(b.existsInRegistry).toBeNull();
  });

  it("returns checksumValid=false for a bad check digit", async () => {
    const res = await postValidate({ law_id: "2000012160145" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as ValidateResult;
    expect(b.formatValid).toBe(true);
    expect(b.checksumValid).toBe(false);
    expect(b.valid).toBe(false);
  });

  it("returns formatValid=false for a malformed law_id", async () => {
    const res = await postValidate({ law_id: "123" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as ValidateResult;
    expect(b.formatValid).toBe(false);
    expect(b.valid).toBe(false);
  });

  it("400 when law_id is missing", async () => {
    const res = await postValidate({});
    expect(res.status).toBe(400);
    const b = (await res.json()) as ApiError;
    expect(b.error.code).toBe("INVALID_REQUEST");
  });
});
