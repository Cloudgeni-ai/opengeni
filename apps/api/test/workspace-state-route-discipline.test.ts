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

  test("uses one bounded aggregate inventory instead of materializing documents per base", () => {
    expect(route).toContain("getDocumentInventory");
    expect(route).toContain("baseLimit: WORKSPACE_STATE_MAX_BASES");
    expect(route).toContain("topicLimit: WORKSPACE_STATE_MAX_TOPICS");
    expect(route).not.toContain("listDocumentBases");
    expect(route).not.toContain("listDocuments");
    expect(route).not.toContain("Promise.all(selectedBases.map");
  });

  test("uses the narrow deterministic Workspace State Memory projection", () => {
    expect(route).toContain("listWorkspaceStateMemoryRecords");
    expect(route).not.toContain("listKnowledgeMemories");
    expect(route).not.toContain("preference_registry");
    expect(route).not.toContain("listPreferenceRegistry");
    expect(route).not.toContain("WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,");
  });

  test("reuses one permission-filtered read for the inventory and sanitized export", () => {
    expect(route).toContain('const base = "/v1/workspaces/:workspaceId/workspace-state"');
    expect(route).toContain("app.get(base");
    expect(route).toContain("app.get(`${base}/export`");
    expect(route.match(/readWorkspaceState\(deps/g)).toHaveLength(2);
    expect(route).toContain("serializeWorkspaceStateExport(state)");
    expect(route).toContain('context.header("cache-control", "private, no-store")');
    expect(route).not.toMatch(/app\.(?:post|put|patch|delete)\(/);
  });
});
