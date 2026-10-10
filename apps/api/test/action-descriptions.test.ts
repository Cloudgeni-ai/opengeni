import { describe, expect, test } from "bun:test";
import { ACTION_CATALOG } from "../src/mcp/action-catalog.gen";
import { actionDescription, DESCRIBED_ACTION_PATH } from "../src/mcp/action-descriptions";
import { describeAction, searchActions } from "../src/organization-mcp";

describe("action descriptions", () => {
  test("every subscription and model settings action has a description", () => {
    const missing = ACTION_CATALOG.filter(
      (entry) => DESCRIBED_ACTION_PATH.test(entry.path) && !actionDescription(entry),
    ).map((entry) => `${entry.method} ${entry.path}`);
    expect(missing).toEqual([]);
  });

  test("descriptions name the provider and the scope", () => {
    expect(
      actionDescription({
        method: "GET",
        path: "/v1/organizations/:organizationId/codex/accounts",
      }),
    ).toContain("Codex (ChatGPT) subscription accounts connected for the organization");
    expect(
      actionDescription({
        method: "PATCH",
        path: "/v1/workspaces/:workspaceId/supergrok/accounts/:accountId/allocator",
      }),
    ).toContain('"Use for new work"');
  });

  test("search matches the words people use and returns the description", () => {
    const found = searchActions({ query: "pause codex account", limit: 5, offset: 0 }).actions;
    const allocator = found.find((action) =>
      action.path.endsWith("/codex/accounts/:accountId/allocator"),
    );
    expect(allocator?.description).toContain("Use for new work");
    const entry = ACTION_CATALOG.find(
      (candidate) =>
        candidate.method === "PUT" &&
        candidate.path ===
          "/v1/organizations/:scopeId/model-connections/:kind/:connectionId/access",
    )!;
    expect(describeAction(entry).description).toContain("which models");
  });
});
