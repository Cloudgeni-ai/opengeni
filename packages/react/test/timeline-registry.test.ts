import { describe, expect, test } from "bun:test";
import { createToolRegistry, rawTypeOf, type ToolRegistryEntry, type ToolRenderer } from "../src/timeline";
import type { ToolCallItem } from "../src/timeline";

/* ----------------------------------------------------------------------------
   Unit tests for the tool-renderer registry (src/timeline/registry.ts).

   Locks the documented resolution order — raw.type > name > generic fallback —
   and the consumer-override precedence that lets a host shadow a built-in.
   -------------------------------------------------------------------------- */

function item(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tc-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "exec_command",
    arguments: {},
    output: "",
    raw: undefined,
    status: "complete",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// Distinct named renderers so resolution can be asserted by identity.
const ByRawType: ToolRenderer = () => null;
const ByName: ToolRenderer = () => null;
const Fallback: ToolRenderer = () => null;
const Override: ToolRenderer = () => null;

const baseEntries: ToolRegistryEntry[] = [
  { match: "rawType", type: "apply_patch_call", render: ByRawType },
  { match: "name", name: "exec_command", render: ByName },
];

describe("rawTypeOf", () => {
  test("reads a string raw.type, else null", () => {
    expect(rawTypeOf(item({ raw: { type: "computer_call" } }))).toBe("computer_call");
    expect(rawTypeOf(item({ raw: { type: 7 } }))).toBeNull();
    expect(rawTypeOf(item({ raw: undefined }))).toBeNull();
    expect(rawTypeOf(item({ raw: null }))).toBeNull();
  });
});

describe("createToolRegistry resolution order", () => {
  const registry = createToolRegistry(baseEntries, Fallback);

  test("1. raw.type wins as the most specific match", () => {
    // name also matches a base entry, but raw.type takes precedence.
    expect(registry.resolve(item({ name: "exec_command", raw: { type: "apply_patch_call" } }))).toBe(ByRawType);
  });

  test("2. tool name matches when no raw.type entry applies", () => {
    expect(registry.resolve(item({ name: "exec_command", raw: undefined }))).toBe(ByName);
    // raw.type present but unregistered -> fall through to the name match.
    expect(registry.resolve(item({ name: "exec_command", raw: { type: "unregistered_type" } }))).toBe(ByName);
  });

  test("3. generic fallback for an unmatched tool", () => {
    expect(registry.resolve(item({ name: "unknown_tool", raw: undefined }))).toBe(Fallback);
    expect(registry.fallback).toBe(Fallback);
  });
});

describe("consumer overrides", () => {
  test("consumer entries shadow a built-in for the same raw.type", () => {
    const registry = createToolRegistry(baseEntries, Fallback, {
      entries: [{ match: "rawType", type: "apply_patch_call", render: Override }],
    });
    expect(registry.resolve(item({ raw: { type: "apply_patch_call" } }))).toBe(Override);
  });

  test("consumer entries shadow a built-in for the same name", () => {
    const registry = createToolRegistry(baseEntries, Fallback, {
      entries: [{ match: "name", name: "exec_command", render: Override }],
    });
    expect(registry.resolve(item({ name: "exec_command", raw: undefined }))).toBe(Override);
  });

  test("the earliest entry wins among duplicate consumer entries", () => {
    const registry = createToolRegistry(baseEntries, Fallback, {
      entries: [
        { match: "name", name: "exec_command", render: Override },
        { match: "name", name: "exec_command", render: ByRawType },
      ],
    });
    expect(registry.resolve(item({ name: "exec_command", raw: undefined }))).toBe(Override);
  });

  test("a consumer can replace the generic fallback", () => {
    const registry = createToolRegistry(baseEntries, Fallback, { fallback: Override });
    expect(registry.resolve(item({ name: "nope", raw: undefined }))).toBe(Override);
    expect(registry.fallback).toBe(Override);
  });
});
