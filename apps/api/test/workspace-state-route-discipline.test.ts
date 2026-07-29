import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(resolve(here, "..", "src", "routes", "workspace-state.ts"), "utf8");

describe("workspace state route discipline", () => {
  test("authenticates the workspace before any inventory read", () => {
    const grantAt = route.indexOf("requireAccessGrant");
    const readAt = route.indexOf("Promise.all");
    expect(grantAt).toBeGreaterThanOrEqual(0);
    expect(route).toContain('"workspace:read"');
    expect(readAt).toBeGreaterThan(grantAt);
  });

  test("gates knowledge independently and preserves private-document subject scope", () => {
    expect(route).toContain('hasPermission(grant.permissions, "documents:search")');
    expect(route).toContain("canInspectKnowledge");
    expect(route).toContain("viewerSubjectId: grant.subjectId");
    expect(route).toContain(": Promise.resolve(null)");
  });

  test("exposes only a no-store GET route with no mutation registration", () => {
    expect(route).toContain('app.get("/v1/workspaces/:workspaceId/workspace-state"');
    expect(route).toContain('context.header("cache-control", "private, no-store")');
    expect(route).not.toMatch(/app\.(?:post|put|patch|delete)\(/);
  });
});
