import { describe, expect, test } from "bun:test";
import {
  defaultSessionMcpServerIds,
  resolveSessionToolPolicy,
  type SessionToolPolicyInput,
} from "../src/domain/session-tool-policy";
import type { ToolRef } from "@opengeni/contracts";

const mcp = (id: string, optional?: boolean): ToolRef => ({
  kind: "mcp",
  id,
  ...(optional ? { optional: true } : {}),
});

function resolve(overrides: Partial<SessionToolPolicyInput> = {}) {
  return resolveSessionToolPolicy({
    toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    sessionTools: [],
    availableMcpServerIds: ["opengeni", "files", "cap-docs", "static-configured"],
    defaultMcpServerIds: ["cap-docs", "files"],
    ...overrides,
  });
}

describe("session tool policy resolution", () => {
  test("workspace defaults add mandatory first-party and default file infrastructure", () => {
    const result = resolve();

    expect(result.toolRefs).toEqual([mcp("cap-docs", true), mcp("files", true), mcp("opengeni")]);
    expect(result.effectivePolicy.selectedIds).toEqual([]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["cap-docs", "files", "opengeni"]);
    expect(result.effectivePolicy.mandatoryIds).toEqual(["opengeni"]);
    expect(result.effectivePolicy.lazyRouter).toEqual({
      state: "required",
      deferredIds: ["cap-docs", "files"],
    });
    expect(result.effectivePolicy.counts).toEqual({
      selected: 0,
      effective: 3,
      mandatory: 1,
      deferred: 2,
      configured: 3,
      dropped: 0,
    });
  });

  test("defaults every configured server except the mandatory carrier", () => {
    expect(
      defaultSessionMcpServerIds([
        { id: "linear" },
        { id: "files" },
        { id: "opengeni" },
        { id: "docs" },
        { id: "linear" },
      ]),
    ).toEqual(["docs", "files", "linear"]);
  });

  test("does not infer static MCPs when the capability default set is omitted", () => {
    const result = resolve({ defaultMcpServerIds: undefined });

    expect(result.toolRefs).toEqual([mcp("opengeni")]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["opengeni"]);
    expect(result.effectivePolicy.counts).toMatchObject({ effective: 1, configured: 1 });
  });

  test("fixed modes search only their configured MCP allow-list", () => {
    for (const mode of ["explicit", "inherited"] as const) {
      const result = resolve({
        toolPolicy: { mode, inheritedFromSessionId: null },
        sessionTools: [mcp("cap-selected")],
        availableMcpServerIds: ["opengeni", "files", "cap-selected"],
      });
      expect(result.toolRefs).toEqual([mcp("cap-selected"), mcp("opengeni")]);
      expect(result.effectivePolicy.effectiveIds).toEqual(["cap-selected", "opengeni"]);
      expect(result.effectivePolicy.lazyRouter).toEqual({
        state: "required",
        deferredIds: ["cap-selected"],
      });
      expect(result.effectivePolicy.counts.selected).toBe(1);
    }
  });

  test("an explicitly selected Slack-shaped MCP is deferred without widening policy", () => {
    const slackId = "cap_integrations_sh_slack_com_5a15dccc0dc0_17qniox";
    const result = resolve({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: [{ kind: "mcp", id: slackId }],
      availableMcpServerIds: ["opengeni", slackId, "unselected-server"],
      defaultMcpServerIds: [],
    });

    expect(result.effectivePolicy.effectiveIds).toEqual([slackId, "opengeni"]);
    expect(result.effectivePolicy.lazyRouter).toEqual({
      state: "required",
      deferredIds: [slackId],
    });
    expect(result.toolRefs.map((tool) => tool.id)).toEqual([slackId, "opengeni"]);
  });

  test("drops unavailable optional history without hiding it from policy truth", () => {
    const result = resolve({
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
      sessionTools: [mcp("retired-capability", true)],
      availableMcpServerIds: ["opengeni", "cap-docs"],
      defaultMcpServerIds: ["cap-docs"],
    });

    expect(result.toolRefs).toEqual([mcp("cap-docs", true), mcp("opengeni")]);
    expect(result.effectivePolicy.effectiveIds).toEqual([
      "cap-docs",
      "opengeni",
      "retired-capability",
    ]);
    expect(result.effectivePolicy.droppedIds).toEqual(["retired-capability"]);
    // Persisted optional refs are a materialized workspace-default snapshot,
    // not a user-pinned selection. The current default and unavailable history
    // stay visible through effective/deferred/dropped truth instead.
    expect(result.effectivePolicy.selectedIds).toEqual([]);
    expect(result.effectivePolicy.counts).toMatchObject({
      selected: 0,
      effective: 3,
      configured: 2,
      dropped: 1,
    });
  });

  test("drops an unavailable explicit selection without trapping future turns", () => {
    const linearId = "cap-integrations-sh-linear-app-retired";
    const result = resolve({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: [mcp(linearId)],
      availableMcpServerIds: ["opengeni"],
      defaultMcpServerIds: [],
    });

    expect(result.toolRefs).toEqual([mcp("opengeni")]);
    expect(result.effectivePolicy.selectedIds).toEqual([linearId]);
    expect(result.effectivePolicy.effectiveIds).toEqual([linearId, "opengeni"]);
    expect(result.effectivePolicy.configuredIds).toEqual(["opengeni"]);
    expect(result.effectivePolicy.droppedIds).toEqual([linearId]);
    expect(result.effectivePolicy.counts).toMatchObject({
      selected: 1,
      effective: 2,
      configured: 1,
      dropped: 1,
    });

    const reconnected = resolve({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: [mcp(linearId)],
      availableMcpServerIds: ["opengeni", linearId],
      defaultMcpServerIds: [],
    });
    expect(reconnected.toolRefs).toEqual([mcp(linearId), mcp("opengeni")]);
    expect(reconnected.effectivePolicy.droppedIds).toEqual([]);
  });

  test("normalizes stable ordering and keeps strict selection over optional selection", () => {
    const result = resolve({
      sessionTools: [mcp("z-server", true), mcp("a-server"), mcp("z-server")],
      availableMcpServerIds: ["opengeni", "a-server", "b-server", "z-server"],
      defaultMcpServerIds: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    });

    expect(result.toolRefs).toEqual([mcp("z-server"), mcp("a-server"), mcp("opengeni")]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["a-server", "opengeni", "z-server"]);
  });

  test("keeps exact counts while bounding exposed IDs", () => {
    const ids = Array.from({ length: 70 }, (_, index) => `cap-${String(index).padStart(2, "0")}`);
    const result = resolve({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: ids.map((id) => mcp(id)),
      availableMcpServerIds: [...ids, "opengeni"],
      defaultMcpServerIds: [],
    });

    expect(result.effectivePolicy.effectiveIds).toHaveLength(64);
    expect(result.effectivePolicy.counts.effective).toBe(71);
    expect(result.effectivePolicy.counts.configured).toBe(71);
    expect(result.effectivePolicy.idsTruncated).toBe(true);
    expect(JSON.stringify(result.effectivePolicy)).not.toContain("Authorization");
    expect(JSON.stringify(result.effectivePolicy)).not.toContain("secret");
  });
});
