import { expect, test } from "bun:test";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";

test("denied or missing artifacts are removed rather than retaining a mounted preview", () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    expect(retainArtifactsAfterRefreshFailure({ status })).toBe(false);
  }
  expect(retainArtifactsAfterRefreshFailure(new Error("Invalid response"))).toBe(false);
});

test("transient refresh failures retain the previous preview", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    expect(retainArtifactsAfterRefreshFailure({ status })).toBe(true);
  }
  expect(retainArtifactsAfterRefreshFailure(new TypeError("Failed to fetch"))).toBe(true);
});
