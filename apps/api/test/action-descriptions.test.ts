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

  // Actions that change something but take no body: the path says it all.
  const BODYLESS =
    /\/(activate|usage\/refresh|refresh|connect\/start|reset-credits\/(prepare|redeem))$|\/organizations\/:organizationId\/(codex|supergrok)\/connect\/start$/;

  test("every subscription and model settings change shows the body to send", () => {
    const missing = ACTION_CATALOG.filter(
      (entry) =>
        DESCRIBED_ACTION_PATH.test(entry.path) &&
        (entry.method === "POST" || entry.method === "PUT" || entry.method === "PATCH") &&
        !BODYLESS.test(entry.path) &&
        !describeAction(entry).input.some((input) => input.schema),
    ).map((entry) => `${entry.method} ${entry.path}`);
    expect(missing).toEqual([]);
  });

  test("describe gives the model access body its fields", () => {
    const entry = ACTION_CATALOG.find(
      (candidate) =>
        candidate.method === "PUT" &&
        candidate.path ===
          "/v1/organizations/:scopeId/model-connections/:kind/:connectionId/access",
    )!;
    const input = describeAction(entry).input[0]!;
    expect(input.in).toBe("body");
    expect(Object.keys((input.schema as { properties: object }).properties).sort()).toEqual([
      "allowPersonalWorkspaces",
      "allowedModels",
      "allowedWorkspaces",
      "version",
    ]);
  });
});
