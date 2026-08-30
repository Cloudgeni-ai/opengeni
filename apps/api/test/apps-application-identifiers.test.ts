import { describe, expect, test } from "bun:test";

import { appFailureIdempotencyKey, derivedWorkspaceAppSlug } from "../src/apps-application";

describe("Apps application identifiers", () => {
  test("derives a bounded stable slug from the requested title", () => {
    const appId = "12345678-1234-4234-8234-123456789abc";
    expect(derivedWorkspaceAppSlug("  Quarterly Operations Console!  ", appId)).toBe(
      "quarterly-operations-console-12345678",
    );
    const long = derivedWorkspaceAppSlug("A ".repeat(100), appId);
    expect(long.length).toBeLessThanOrEqual(96);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
  });

  test("uses a bounded internal namespace for verification failures", () => {
    const original = "x".repeat(200);
    const source = appFailureIdempotencyKey("source", "workspace", "app", "resource", original);
    expect(source).toMatch(/^[0-9a-f-]{36}$/u);
    expect(source.length).toBeLessThanOrEqual(200);
    expect(appFailureIdempotencyKey("source", "workspace", "app", "resource", original)).toBe(
      source,
    );
    expect(appFailureIdempotencyKey("build", "workspace", "app", "resource", original)).not.toBe(
      source,
    );
  });
});
