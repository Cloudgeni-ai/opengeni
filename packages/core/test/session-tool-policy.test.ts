import { describe, expect, test } from "bun:test";
import {
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
    availableMcpServerIds: ["opengeni", "cap-docs", "static-configured"],
    defaultMcpServerIds: ["cap-docs"],
    ...overrides,
  });
}

describe("session tool policy resolution", () => {
  test("workspace defaults are capability-only and add the mandatory first-party server", () => {
    const result = resolve();

    expect(result.toolRefs).toEqual([mcp("cap-docs", true), mcp("opengeni")]);
    expect(result.effectivePolicy.selectedIds).toEqual([]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["cap-docs", "opengeni"]);
    expect(result.effectivePolicy.mandatoryIds).toEqual(["opengeni"]);
    expect(result.effectivePolicy.lazyRouter).toEqual({
      state: "required",
      deferredIds: ["cap-docs"],
    });
    expect(result.effectivePolicy.counts).toEqual({
      selected: 0,
      effective: 2,
      mandatory: 1,
      deferred: 1,
      configured: 2,
      dropped: 0,
    });
  });

  test("does not infer static MCPs when the capability default set is omitted", () => {
    const result = resolve({ defaultMcpServerIds: undefined });

    expect(result.toolRefs).toEqual([mcp("opengeni")]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["opengeni"]);
    expect(result.effectivePolicy.counts).toMatchObject({ effective: 1, configured: 1 });
  });

  test("fixed modes never widen from configured defaults", () => {
    for (const mode of ["explicit", "inherited", "legacy"] as const) {
      const result = resolve({
        toolPolicy: { mode, inheritedFromSessionId: null },
        sessionTools: [mcp("cap-selected")],
      });
      expect(result.toolRefs).toEqual([mcp("cap-selected"), mcp("opengeni")]);
      expect(result.effectivePolicy.effectiveIds).toEqual(["cap-selected", "opengeni"]);
      expect(result.effectivePolicy.lazyRouter).toEqual({
        state: "disabled",
        deferredIds: [],
      });
      expect(result.effectivePolicy.counts.selected).toBe(1);
    }
  });

  test("distinguishes omitted turn tools from an explicit empty narrowing", () => {
    const omitted = resolve({
      sessionTools: [mcp("cap-docs", true)],
      turnTools: [],
      turnToolsProvided: false,
    });
    expect(omitted.toolRefs).toEqual([mcp("cap-docs", true), mcp("opengeni")]);
    expect(omitted.effectivePolicy.lazyRouter.state).toBe("required");

    const explicitEmpty = resolve({
      sessionTools: [mcp("cap-docs", true)],
      turnTools: [],
      turnToolsProvided: true,
    });
    expect(explicitEmpty.toolRefs).toEqual([mcp("opengeni")]);
    expect(explicitEmpty.effectivePolicy.lazyRouter).toEqual({
      state: "disabled",
      deferredIds: [],
    });
  });

  test("an explicit follow-up replaces rather than merges the session selection", () => {
    const result = resolve({
      sessionTools: [mcp("cap-docs"), mcp("static-configured")],
      turnTools: [mcp("cap-docs")],
      turnToolsProvided: true,
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    });
    expect(result.toolRefs).toEqual([mcp("cap-docs"), mcp("opengeni")]);
    expect(result.effectivePolicy.effectiveIds).toEqual(["cap-docs", "opengeni"]);
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

  test("normalizes stable ordering and keeps strict selection over optional selection", () => {
    const result = resolve({
      sessionTools: [mcp("z-server", true), mcp("a-server"), mcp("z-server")],
      turnTools: [mcp("b-server")],
      availableMcpServerIds: ["opengeni", "a-server", "b-server", "z-server"],
      defaultMcpServerIds: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    });

    expect(result.toolRefs).toEqual([
      mcp("z-server"),
      mcp("a-server"),
      mcp("b-server"),
      mcp("opengeni"),
    ]);
    expect(result.effectivePolicy.effectiveIds).toEqual([
      "a-server",
      "b-server",
      "opengeni",
      "z-server",
    ]);
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
