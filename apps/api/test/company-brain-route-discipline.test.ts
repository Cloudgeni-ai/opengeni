import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(resolve(here, "..", "src", "routes", "company-brain.ts"), "utf8");

describe("Company Brain route discipline", () => {
  test("keeps route, subject, knowledge permission, and private-cache fences explicit", () => {
    expect(route).toContain('requireAccessGrant(context, deps, workspaceId, "workspace:read")');
    expect(route).toContain('hasPermission(grant.permissions, "documents:search")');
    expect(route).toContain("subjectId: grant.subjectId");
    expect(route).toContain("subjectId: input.subjectId");
    expect(route).toContain('context.header("cache-control", "private, no-store")');
    expect(route).toContain('surface: "human"');
    expect(route).toContain('requireAccessGrant(context, deps, workspaceId, "documents:search")');
    expect(route).toContain("inspectCompanyBrainContextReceipts");
    expect(route).toContain("listCompanyBrainKnowledgeProposals");
    expect(route).toContain("context receipt cursor belongs to another scope");
    expect(route).not.toContain("resolveCompanyBrainContextSelection");
  });
});
