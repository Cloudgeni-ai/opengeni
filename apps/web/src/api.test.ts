import { describe, expect, test } from "bun:test";
import { authHeadersForAccessKey, resolveApiBaseUrl } from "./api";

describe("web API auth helpers", () => {
  test("builds bearer authorization headers from a client-side access key", () => {
    expect(authHeadersForAccessKey(null)).toEqual({});
    expect(authHeadersForAccessKey("secret")).toEqual({ authorization: "Bearer secret" });
  });

  test("defaults to same-origin API paths for deployed web builds", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("");
    expect(resolveApiBaseUrl("https://opengeni.example.com/")).toBe("https://opengeni.example.com");
  });
});
