import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OrgAgentDefinition,
  canonicalOrgAgentDefinitionJson,
  type OrgAgentToolServerConfig,
} from "@opengeni/contracts";
import { parseConsoleAgentSearch } from "./console-route";
import {
  agentKeyFromName,
  hasOverrides,
  newToolServerConfig,
  orgAgentConfigHash,
  orgAgentYaml,
  orgAgentsApi,
  orgAgentsEnabled,
  overrideEntries,
  parseOrgAgentYaml,
  sameDefinition,
  shortConfigHash,
  toolRows,
  versionSourceLabel,
  withNewTools,
  withToolAsk,
  withToolOn,
  listWorkspaceOrgAgents,
} from "./organization-agents";

const organizationId = "33333333-3333-4333-8333-333333333333";

const definition = OrgAgentDefinition.parse({
  name: "Support desk",
  description: "Answers billing questions",
  instructions: "Be brief.\n\nAlways say which invoice you looked at.",
  config: {
    model: "azure-sol/gpt-6.1-sol",
    reasoningEffort: "medium",
    capabilities: { from: "none", webSearch: true },
    toolServers: [
      {
        server: "billing",
        tools: { mode: "selected", enabled: ["refund", "lookup_invoice"] },
        approval: { ask: ["refund"] },
        newTools: "on_with_approval",
      },
    ],
    workers: { shareInstructions: true },
  },
});

function sha256(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("Export as YAML", () => {
  test("round-trips to the same canonical definition and config hash", async () => {
    const yaml = orgAgentYaml("support-desk", definition);
    const back = parseOrgAgentYaml(yaml);
    expect(back.key).toBe("support-desk");
    expect(canonicalOrgAgentDefinitionJson(back.definition)).toBe(
      canonicalOrgAgentDefinitionJson(definition),
    );
    expect(sameDefinition(back.definition, definition)).toBe(true);
    const hash = await orgAgentConfigHash(definition);
    expect(hash).toBe(sha256(canonicalOrgAgentDefinitionJson(definition)));
    expect(await orgAgentConfigHash(back.definition)).toBe(hash);
  });

  test("a minimal agent round-trips too", async () => {
    const minimal = OrgAgentDefinition.parse({ name: "Plain" });
    const back = parseOrgAgentYaml(orgAgentYaml("plain", minimal));
    expect(await orgAgentConfigHash(back.definition)).toBe(await orgAgentConfigHash(minimal));
  });

  test("any change changes the hash", async () => {
    const changed = OrgAgentDefinition.parse({ ...definition, instructions: "Be very brief." });
    expect(await orgAgentConfigHash(changed)).not.toBe(await orgAgentConfigHash(definition));
  });
});

describe("tool rows", () => {
  const server = (overrides: Partial<OrgAgentToolServerConfig> = {}): OrgAgentToolServerConfig => ({
    server: "billing",
    tools: { mode: "selected", enabled: ["lookup_invoice", "refund"] },
    approval: { ask: ["refund"] },
    eager: [],
    newTools: "off",
    ...overrides,
  });
  const live = [
    { name: "lookup_invoice", description: "Find an invoice" },
    { name: "refund" },
    { name: "void_invoice" },
  ];
  const catalog = { billing: [{ name: "lookup_invoice" }, { name: "refund" }, { name: "old" }] };

  test("marks new tools and follows the server's new-tools choice", () => {
    const off = toolRows(server(), live, catalog);
    expect(off.map((row) => [row.name, row.on, row.ask, row.isNew])).toEqual([
      ["lookup_invoice", true, false, false],
      ["refund", true, true, false],
      ["void_invoice", false, false, true],
    ]);
    const ask = toolRows(server({ newTools: "on_with_approval" }), live, catalog);
    expect(ask.find((row) => row.name === "void_invoice")).toMatchObject({ on: true, ask: true });
    const on = toolRows(server({ newTools: "on" }), live, catalog);
    expect(on.find((row) => row.name === "void_invoice")).toMatchObject({ on: true, ask: false });
  });

  test("keeps an enabled tool the server no longer offers, marked gone", () => {
    const rows = toolRows(
      server({ tools: { mode: "selected", enabled: ["lookup_invoice", "old"] } }),
      live,
      catalog,
    );
    expect(rows.find((row) => row.name === "old")).toMatchObject({ on: true, gone: true });
  });

  test("without a saved catalog nothing is new", () => {
    expect(toolRows(server(), live, null).some((row) => row.isNew)).toBe(false);
  });

  test("turning a tool off from 'all' lists the rest and drops its ask", () => {
    const names = live.map((tool) => tool.name);
    const next = withToolOn(
      server({ tools: { mode: "all", enabled: [] }, eager: ["refund"] }),
      "refund",
      false,
      names,
    );
    expect(next.tools).toEqual({ mode: "selected", enabled: ["lookup_invoice", "void_invoice"] });
    expect(next.approval.ask).toEqual([]);
    expect(next.eager).toEqual([]);
    expect(withToolOn(server(), "void_invoice", true, names).tools.enabled).toEqual([
      "lookup_invoice",
      "refund",
      "void_invoice",
    ]);
  });

  test("ask first per tool, and 'every tool asks' becomes a list", () => {
    const names = live.map((tool) => tool.name);
    expect(withToolAsk(server(), "lookup_invoice", true, names).approval.ask).toEqual([
      "lookup_invoice",
      "refund",
    ]);
    expect(withToolAsk(server({ approval: { ask: true } }), "refund", false, names).approval.ask).toEqual(
      ["lookup_invoice", "void_invoice"],
    );
    expect(withNewTools(server(), "on").newTools).toBe("on");
  });

  test("an added server starts with today's tools on and new tools off", () => {
    expect(newToolServerConfig("crm", ["b", "a"])).toEqual({
      server: "crm",
      tools: { mode: "selected", enabled: ["a", "b"] },
      approval: { ask: [] },
      eager: [],
      newTools: "off",
    });
  });
});

describe("overrides", () => {
  test("one entry per setting, known settings first, values as text", () => {
    const entries = overrideEntries({
      "toolServers.billing": { agent: { newTools: "off" }, chat: { newTools: "on" } },
      instructions: { agent: "Be brief.", chat: "Be brief.\n\nAnswer in Norwegian." },
      model: { agent: "azure-sol/gpt-6.1-sol", chat: "anthropic/claude-opus-5.5" },
    });
    expect(entries.map((entry) => entry.label)).toEqual([
      "Model",
      "Instructions",
      "Tool server billing",
    ]);
    expect(entries[0]).toMatchObject({ agent: "azure-sol/gpt-6.1-sol", chat: "anthropic/claude-opus-5.5" });
    expect(entries[2]?.chat).toContain('"newTools": "on"');
    expect(hasOverrides(null)).toBe(false);
    expect(hasOverrides({})).toBe(false);
    expect(hasOverrides({ model: { agent: "a", chat: "b" } })).toBe(true);
  });
});

describe("labels", () => {
  test("keys, sources and hashes", () => {
    expect(agentKeyFromName("Støtte  Desk!")).toBe("stotte-desk");
    expect(versionSourceLabel("inline")).toBe("Chat");
    expect(versionSourceLabel("deploy")).toBe("Deploy");
    expect(shortConfigHash(`sha256:${"a".repeat(64)}`)).toBe("a".repeat(12));
  });
});

describe("flag", () => {
  test("reads the organization list or the boolean", () => {
    expect(orgAgentsEnabled({ orgAgentsAccountIds: [organizationId.toUpperCase()] }, organizationId)).toBe(
      true,
    );
    expect(orgAgentsEnabled({ orgAgentsAccountIds: [] }, organizationId)).toBe(false);
    expect(orgAgentsEnabled({ orgAgents: true }, organizationId)).toBe(true);
    expect(orgAgentsEnabled({ orgAgents: true }, null)).toBe(false);
    expect(orgAgentsEnabled({}, organizationId)).toBe(false);
  });
});

describe("calls", () => {
  test("go to the organization's public routes", async () => {
    const requestJson = mock(async (..._args: unknown[]) => ({
      agent: { id: "a" },
      toolServer: { key: "billing" },
      operation: { id: "op" },
    }));
    const api = orgAgentsApi({ requestJson } as never, organizationId);
    await api.listAgents();
    await api.getAgent("support-desk");
    await api.saveDraft("a1", { expectedVersion: 2, definition } as never);
    await api.movableChats("a1", 3);
    await api.publish("a1", { version: 3, moveRunningChats: true } as never);
    await api.getPublishOperation("a1", "op1");
    await api.startTestChat("a1", { version: 3, message: "Hi" });
    await api.listToolServerTools("billing");
    await api.deleteToolServer("billing");
    await listWorkspaceOrgAgents({ requestJson } as never, "ws");
    const base = `/v1/organizations/${organizationId}`;
    expect(requestJson.mock.calls.map((call) => `${call[0]} ${call[1]}`)).toEqual([
      `GET ${base}/agents`,
      `GET ${base}/agents/support-desk`,
      `PUT ${base}/agents/a1/draft`,
      `GET ${base}/agents/a1/movable-chats`,
      `POST ${base}/agents/a1/publish`,
      `GET ${base}/agents/a1/publish-operations/op1`,
      `POST ${base}/agents/a1/test-chats`,
      `GET ${base}/tool-servers/billing/tools`,
      `DELETE ${base}/tool-servers/billing`,
      "GET /v1/workspaces/ws/organization-agents",
    ]);
    expect(requestJson.mock.calls[3]?.[3]).toEqual({ version: "3" });
  });
});

describe("agent page search", () => {
  test("keeps known tabs and well-formed values only", () => {
    expect(
      parseConsoleAgentSearch({ org: organizationId, tab: "versions", from: "2", to: 3 }),
    ).toMatchObject({ tab: "versions", from: 2, to: 3 });
    const odd = parseConsoleAgentSearch({ tab: "nope", session: "x", from: "-1" });
    expect(odd.tab).toBeUndefined();
    expect(odd.session).toBeUndefined();
    expect(odd.from).toBeUndefined();
  });
});
