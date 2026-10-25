import { describe, expect, test } from "bun:test";
import { CapabilityCatalogItem, type Session } from "@opengeni/contracts";
import { capabilitySetupReadiness } from "../src/capability-setup-readiness";

function item(overrides: Record<string, unknown>) {
  return CapabilityCatalogItem.parse({
    id: "mcp:mail",
    kind: "mcp",
    source: "registry",
    name: "Mail",
    enabled: true,
    tools: [],
    runtime: { available: true, mcpServerId: "mail", notes: null },
    ...overrides,
  });
}

type ChatTools = Pick<Session, "tools" | "firstPartyMcpTools" | "effectiveToolPolicy">;

function chat(effectiveIds: string[] | null, options: Partial<ChatTools> = {}): ChatTools {
  return {
    tools: [],
    firstPartyMcpTools: [],
    effectiveToolPolicy:
      effectiveIds === null
        ? undefined
        : {
            mode: "explicit",
            inheritedFromSessionId: null,
            selectedIds: effectiveIds,
            effectiveIds,
            mandatoryIds: [],
            lazyRouter: { state: "disabled", deferredIds: [] },
            configuredIds: effectiveIds,
            droppedIds: [],
            counts: {
              selected: effectiveIds.length,
              effective: effectiveIds.length,
              mandatory: 0,
              deferred: 0,
              configured: effectiveIds.length,
              dropped: 0,
            },
            idsTruncated: false,
          },
    ...options,
  };
}

describe("capabilitySetupReadiness", () => {
  test("an enabled MCP is ready only once its server is in the chat", () => {
    expect(capabilitySetupReadiness("mcp:mail", item({}), chat([]))).toBe("not_ready");
    expect(capabilitySetupReadiness("mcp:mail", item({}), chat(["mail"]))).toBe("ready");
    expect(capabilitySetupReadiness("mcp:mail", item({ enabled: false }), chat(["mail"]))).toBe(
      "not_ready",
    );
    expect(capabilitySetupReadiness("mcp:mail", undefined, chat(["mail"]))).toBe("not_ready");
  });

  test("without a policy projection the chat's own tool list decides", () => {
    expect(
      capabilitySetupReadiness(
        "mcp:mail",
        item({}),
        chat(null, { tools: [{ kind: "mcp", id: "mail" }] }),
      ),
    ).toBe("ready");
    expect(capabilitySetupReadiness("mcp:mail", item({}), chat(null))).toBe("not_ready");
  });

  test("a truncated policy id list cannot prove absence", () => {
    const truncated = chat([]);
    truncated.effectiveToolPolicy!.idsTruncated = true;
    expect(capabilitySetupReadiness("mcp:mail", item({}), truncated)).toBe("assumed_ready");
  });

  test("built-in tools are chosen by name, not by server id", () => {
    const fiken = item({
      id: "api:fiken",
      kind: "api",
      source: "built_in",
      surfaceType: "first_party_fiken",
      tools: [{ kind: "mcp", id: "opengeni" }],
      runtime: { available: true, mcpServerId: "opengeni", notes: null },
      metadata: { connectionStatus: "active", firstPartyMcpTools: ["fiken_invoices_list"] },
    });
    expect(capabilitySetupReadiness("api:fiken", fiken, chat([]))).toBe("not_ready");
    expect(
      capabilitySetupReadiness(
        "api:fiken",
        fiken,
        chat([], { firstPartyMcpTools: ["fiken_invoices_list"] }),
      ),
    ).toBe("ready");
    expect(
      capabilitySetupReadiness(
        "api:fiken",
        { ...fiken, metadata: { ...fiken.metadata, connectionStatus: "needs_reauth" } },
        chat([], { firstPartyMcpTools: ["fiken_invoices_list"] }),
      ),
    ).toBe("not_ready");
  });

  test("skills are ready once enabled; self-reporting cards are not applicable", () => {
    expect(
      capabilitySetupReadiness(
        "skill:notes",
        item({ id: "skill:notes", kind: "skill", runtime: { available: true, notes: null } }),
        chat([]),
      ),
    ).toBe("ready");
    expect(capabilitySetupReadiness("api:github-app", undefined, chat([]))).toBe("not_applicable");
    expect(capabilitySetupReadiness("api:connected-machine", undefined, chat([]))).toBe(
      "not_applicable",
    );
  });
});
