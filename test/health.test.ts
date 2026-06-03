import { describe, it, expect } from "vitest";
import app from "@/index";
import type { ApiError } from "@/types";

const ENV = { API_VERSION: "0.1.0-poc-test" };

describe("corporation API skeleton", () => {
  it("health returns ok with version", async () => {
    const res = await app.request("/api/v1/corporation/health", {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      api: string;
      version: string;
    };
    expect(body.status).toBe("ok");
    expect(body.api).toBe("corporation");
    expect(body.version).toBe(ENV.API_VERSION);
  });

  it("planned endpoints return 501 with typed error", async () => {
    for (const ep of ["lookup", "search", "normalize", "validate", "batch"]) {
      const res = await app.request(
        `/api/v1/corporation/${ep}`,
        { method: "POST" },
        ENV
      );
      expect(res.status).toBe(501);
      const body = (await res.json()) as ApiError;
      expect(body.error.code).toBe("NOT_IMPLEMENTED");
    }
  });
});
