import { describe, it, expect } from "vitest";
import { timingSafeEqual, verifyAdminToken } from "@/core/admin-auth";

describe("timingSafeEqual", () => {
  it("true for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("false for different content of equal length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("false for different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("verifyAdminToken", () => {
  it("disabled when no token configured", () => {
    expect(verifyAdminToken(undefined, "x")).toBe("disabled");
    expect(verifyAdminToken("", "x")).toBe("disabled");
  });

  it("unauthorized when provided is missing or empty", () => {
    expect(verifyAdminToken("secret", null)).toBe("unauthorized");
    expect(verifyAdminToken("secret", "")).toBe("unauthorized");
  });

  it("unauthorized on mismatch", () => {
    expect(verifyAdminToken("secret", "nope")).toBe("unauthorized");
  });

  it("ok on exact match", () => {
    expect(verifyAdminToken("secret", "secret")).toBe("ok");
  });
});
