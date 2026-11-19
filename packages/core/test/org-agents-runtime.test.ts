// Organization (Console) agents at runtime, pure parts: how a version and a
// create request become an ordinary create body plus recorded overrides, how
// tool servers are materialized (newTools, approvals, disabled tools), how a
// publish move re-materializes a chat, and that a create without an
// organization agent never enters this code.
import { describe, expect, test } from "bun:test";
import {
  OrgAgentDefinition,
  OrgAgentSessionRequest,
  OrgAgentVersionConfig,
  sessionAgentFieldNamesOrgAgent,
  type OrgAgentVersionConfigInput,
  type ToolRef,
} from "@opengeni/contracts";
import {
  materializeOrgToolServer,
  mergeOrgAgentCapabilities,
  planOrgAgentSessionMove,
  type OrgAgentMoveServerRow,
} from "../src/domain/org-agent-config";
import {
  endUserLoginHeaders,
  orgAgentConfigHash,
  planOrgAgentSessionCreate,
} from "../src/domain/org-agents";

const CRM = { key: "crm", name: "CRM", url: "https://crm.example.com/mcp" };
const DOCS = { key: "docs", name: "Docs", url: "https://docs.example.com/mcp" };
const BILLING = { key: "billing", name: "Billing", url: "https://billing.example.com/mcp" };

const VERSION: OrgAgentVersionConfigInput = {
  model: "gpt-5",
  reasoningEffort: "medium",
  capabilities: { from: "all", webSearch: false },
  identity: "You are Support.",
  toolServers: [
    {
      server: "crm",
      tools: { mode: "selected", enabled: ["lookup", "update"] },
      approval: { ask: ["update"] },
      eager: ["lookup"],
      newTools: "on_with_approval",
    },
    { server: "docs", tools: { mode: "all" } },
  ],
};
const CATALOG = {
  crm: [{ name: "lookup" }, { name: "update" }, { name: "delete" }],
  docs: [{ name: "read" }, { name: "drop" }],
};
const LIVE: Record<string, string[]> = {
  crm: ["lookup", "update", "delete", "export"],
  docs: ["read", "drop"],
};

async function plan(
  agent: unknown,
  extra: Record<string, unknown> = {},
  options: {
    config?: OrgAgentVersionConfigInput;
    toolServers?: (typeof CRM)[];
    live?: Record<string, string[] | null>;
    /** Organization-level agents:manage: the chat may give more than the agent. */
    mayWiden?: boolean;
  } = {},
) {
  const raw: Record<string, unknown> = { initialMessage: "hi", agent, ...extra };
  const request = OrgAgentSessionRequest.parse(typeof agent === "string" ? { ref: agent } : agent);
  const listed: string[] = [];
  const result = await planOrgAgentSessionCreate({
    raw,
    request,
    config: OrgAgentVersionConfig.parse(options.config ?? VERSION),
    toolCatalog: CATALOG,
    toolServers: new Map(
      (options.toolServers ?? [CRM, DOCS]).map((server) => [server.key, server]),
    ),
    liveTools: async (server) => {
      listed.push(server.key);
      const live = options.live ?? LIVE;
      return live[server.key] ?? null;
    },
    mayWiden: options.mayWiden === true,
  });
  return { ...result, listed };
}

describe("organization agent session create plan", () => {
  test("live tool lists are fetched in parallel under one deadline", async () => {
    const config = OrgAgentVersionConfig.parse({
      toolServers: [
        { server: "crm", tools: { mode: "selected", enabled: ["lookup"] }, newTools: "on" },
        { server: "docs", tools: { mode: "selected", enabled: ["read"] }, newTools: "on" },
        { server: "billing", tools: { mode: "selected", enabled: ["charge"] }, newTools: "on" },
      ],
    });
    const started: string[] = [];
    const live: Record<string, string[]> = {
      crm: ["lookup", "export"],
      docs: ["read", "search"],
    };
    const at = performance.now();
    const result = await planOrgAgentSessionCreate({
      raw: { initialMessage: "hi", agent: "support" },
      request: OrgAgentSessionRequest.parse({ ref: "support" }),
      config,
      toolCatalog: { crm: [{ name: "lookup" }], docs: [{ name: "read" }], billing: [] },
      toolServers: new Map([CRM, DOCS, BILLING].map((server) => [server.key, server])),
      liveTools: async (server) => {
        started.push(server.key);
        // Billing never answers; the others take 300 ms each.
        if (server.key === "billing") return await new Promise<string[] | null>(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        return live[server.key] ?? null;
      },
      liveToolsDeadlineMs: 800,
    });
    const elapsed = performance.now() - at;
    // All three started at once; the create waited for the deadline, not 3 × 300 ms + a hang.
    expect(started).toEqual(["crm", "docs", "billing"]);
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(1_500);
    const servers = result.payload["mcpServers"] as Record<string, unknown>[];
    expect(servers.map((server) => [server["id"], server["allowedTools"]])).toEqual([
      ["crm", ["lookup", "export"]],
      ["docs", ["read", "search"]],
      // Not back in time: the version's own selection.
      ["billing", ["charge"]],
    ]);
  });

  test("an unchanged agent becomes an ordinary create with no overrides", async () => {
    const result = await plan("support", { agentOverrides: "reject" });
    expect(result.overrides).toBeNull();
    expect(result.payload).toEqual({
      initialMessage: "hi",
      agent: { capabilities: { from: "all", webSearch: false }, identity: "You are Support." },
      model: "gpt-5",
      reasoningEffort: "medium",
      mcpServers: [
        {
          id: "crm",
          name: "CRM",
          url: CRM.url,
          // A tool offered now but not when the version was saved is new: on, behind approval.
          allowedTools: ["lookup", "update", "export"],
          eager: ["lookup"],
          requireApproval: ["update", "export"],
        },
        { id: "docs", name: "Docs", url: DOCS.url },
      ],
    });
    // No credentials ever ride on the materialized servers.
    for (const server of result.payload["mcpServers"] as Record<string, unknown>[]) {
      expect(server["headers"]).toBeUndefined();
    }
    expect([...result.agentServerIds]).toEqual(["crm", "docs"]);
    // Only the server whose newTools rule needs it is listed live.
    expect(result.listed).toEqual(["crm"]);
  });

  test("the request wins and every change is recorded as {agent, chat}", async () => {
    const result = await plan(
      {
        ref: "support",
        capabilities: { from: "all", browser: false },
        toolServers: [
          { server: "crm", disableTools: ["update"], headers: { Authorization: "Bearer chat" } },
          { server: "docs", enabled: false },
        ],
      },
      {
        model: "claude-x",
        instructions: "Answer in Norwegian.",
        mcpServers: [{ id: "mine", url: "https://mine.example.com/mcp" }],
      },
    );
    expect(Object.keys(result.overrides ?? {}).sort()).toEqual([
      "capabilities",
      "instructions",
      "mcpServers.mine",
      "model",
      "toolServers.crm",
      "toolServers.docs",
    ]);
    expect(result.overrides?.["model"]).toEqual({ agent: "gpt-5", chat: "claude-x" });
    // Extra instructions are added after the agent's, never replacing them.
    expect(result.overrides?.["instructions"]).toEqual({
      agent: null,
      chat: "Answer in Norwegian.",
    });
    expect(result.overrides?.["toolServers.crm"]?.chat).toEqual({ disableTools: ["update"] });
    expect(result.overrides?.["toolServers.docs"]?.chat).toEqual({ enabled: false });
    expect(result.payload["model"]).toBe("claude-x");
    expect(result.payload["reasoningEffort"]).toBe("medium");
    expect(result.payload["instructions"]).toBe("Answer in Norwegian.");
    expect(result.payload["agent"]).toEqual({
      capabilities: { from: "all", webSearch: false, browser: false },
      identity: "You are Support.",
    });
    expect(result.payload["mcpServers"]).toEqual([
      {
        id: "crm",
        name: "CRM",
        url: CRM.url,
        allowedTools: ["lookup", "export"],
        eager: ["lookup"],
        requireApproval: ["update", "export"],
        // The chat's own login: stored like any session MCP header (write-only).
        headers: { Authorization: "Bearer chat" },
      },
      { id: "mine", url: "https://mine.example.com/mcp" },
    ]);
    expect([...result.agentServerIds]).toEqual(["crm"]);
  });

  test("a login alone and a value equal to the agent's are not overrides", async () => {
    const result = await plan(
      {
        ref: "support",
        identity: "You are Support.",
        toolServers: [{ server: "crm", headers: { "X-Key": "k" } }],
      },
      { model: "gpt-5" },
    );
    expect(result.overrides).toBeNull();
    expect((result.payload["mcpServers"] as { headers?: unknown }[])[0]?.headers).toEqual({
      "X-Key": "k",
    });
  });

  test("a request MCP server with an agent server's id replaces it", async () => {
    const result = await plan(
      "support",
      { mcpServers: [{ id: "docs", url: "https://other.example.com/mcp" }] },
      { mayWiden: true },
    );
    expect(result.payload["mcpServers"]).toEqual([
      expect.objectContaining({ id: "crm" }),
      { id: "docs", url: "https://other.example.com/mcp" },
    ]);
    expect(result.overrides?.["mcpServers.docs"]).toEqual({
      agent: { id: "docs", name: "Docs", url: DOCS.url },
      chat: { id: "docs", url: "https://other.example.com/mcp" },
    });
    expect([...result.agentServerIds]).toEqual(["crm"]);
  });

  test("replacing the tool selection and approval is recorded and applied", async () => {
    const result = await plan(
      {
        ref: "support",
        toolServers: [
          {
            server: "crm",
            tools: { mode: "selected", enabled: ["delete"] },
            approval: { ask: true },
          },
          { server: "docs", disableTools: ["drop"], eager: ["read"] },
        ],
      },
      {},
      { mayWiden: true },
    );
    const [crm, docs] = result.payload["mcpServers"] as Record<string, unknown>[];
    expect(crm).toMatchObject({ allowedTools: ["delete", "export"], requireApproval: true });
    // "all" with a disabled tool needs the server's tool list.
    expect(docs).toMatchObject({ allowedTools: ["read"], eager: ["read"] });
    expect(result.listed.sort()).toEqual(["crm", "docs"]);
    expect(Object.keys(result.overrides ?? {}).sort()).toEqual([
      "toolServers.crm",
      "toolServers.docs",
    ]);
  });

  test("without organization agents:manage a chat may only narrow the agent's tool servers", async () => {
    // Narrowing: fewer of the agent's tools, more "Ask first", servers or tools off.
    const narrowed = await plan({
      ref: "support",
      toolServers: [
        {
          server: "crm",
          tools: { mode: "selected", enabled: ["lookup"] },
          approval: { ask: ["update", "lookup"] },
        },
        { server: "docs", tools: { mode: "selected", enabled: ["read"] }, approval: { ask: true } },
      ],
    });
    const [crm, docs] = narrowed.payload["mcpServers"] as Record<string, unknown>[];
    expect(crm).toMatchObject({
      allowedTools: ["lookup", "export"],
      requireApproval: ["update", "lookup", "export"],
    });
    expect(docs).toMatchObject({ allowedTools: ["read"], requireApproval: true });
    expect(Object.keys(narrowed.overrides ?? {}).sort()).toEqual([
      "toolServers.crm",
      "toolServers.docs",
    ]);

    const refused = async (agent: unknown, extra: Record<string, unknown> = {}) => {
      const error = await plan(agent, extra).then(
        () => null,
        (caught: unknown) => caught as { httpStatus?: number; code?: string; message?: string },
      );
      return { status: error?.httpStatus, code: error?.code, message: error?.message ?? "" };
    };
    // A tool the agent left off.
    const added = await refused({
      ref: "support",
      toolServers: [{ server: "crm", tools: { mode: "selected", enabled: ["lookup", "delete"] } }],
    });
    expect(added).toMatchObject({ status: 403, code: "agents_manage_required" });
    expect(added.message).toContain("'delete'");
    // Every tool of a server the agent limits.
    expect(
      await refused({ ref: "support", toolServers: [{ server: "crm", tools: { mode: "all" } }] }),
    ).toMatchObject({ status: 403, code: "agents_manage_required" });
    // "Ask first" taken away, partly or fully.
    expect(
      await refused({ ref: "support", toolServers: [{ server: "crm", approval: { ask: [] } }] }),
    ).toMatchObject({ status: 403, code: "agents_manage_required" });
    expect(
      await refused(
        { ref: "support", toolServers: [{ server: "crm", approval: { ask: ["lookup"] } }] },
        {},
      ),
    ).toMatchObject({ status: 403, code: "agents_manage_required" });
    // One of the agent's servers replaced through mcpServers.
    expect(
      await refused("support", {
        mcpServers: [{ id: "crm", url: "https://crm.example.com/mcp" }],
      }),
    ).toMatchObject({ status: 403, code: "agents_manage_required" });
    // A server under a new id is the chat's own (checked like any mcpServers).
    const own = await plan("support", {
      mcpServers: [{ id: "mine", url: "https://mine.example.com/mcp" }],
    });
    expect([...own.agentServerIds].sort()).toEqual(["crm", "docs"]);
    // With organization agents:manage the same widening is applied and recorded.
    const widened = await plan(
      {
        ref: "support",
        toolServers: [{ server: "crm", tools: { mode: "all" }, approval: { ask: [] } }],
      },
      {},
      { mayWiden: true },
    );
    expect((widened.payload["mcpServers"] as Record<string, unknown>[])[0]).not.toHaveProperty(
      "allowedTools",
    );
    expect(widened.overrides?.["toolServers.crm"]?.chat).toEqual({
      tools: { mode: "all", enabled: [] },
      approval: { ask: [] },
    });
  });

  test("newTools off, an unlisted server and a deleted tool server", async () => {
    const config: OrgAgentVersionConfigInput = {
      toolServers: [
        { server: "crm", tools: { mode: "selected", enabled: ["lookup"] } },
        { server: "gone", tools: { mode: "all" } },
      ],
    };
    const result = await plan("support", {}, { config, live: { crm: null } });
    expect(result.payload["mcpServers"]).toEqual([
      { id: "crm", name: "CRM", url: CRM.url, allowedTools: ["lookup"] },
    ]);
    // newTools off never lists the server; nothing from the version fills unset fields.
    expect(result.listed).toEqual([]);
    expect(result.payload["model"]).toBeUndefined();
    expect(result.payload["agent"]).toBeUndefined();
    // A server that cannot be listed gets only the version's tools.
    const unlisted = await plan("support", {}, { live: { crm: null } });
    expect(
      (unlisted.payload["mcpServers"] as { allowedTools?: string[] }[])[0]?.allowedTools,
    ).toEqual(["lookup", "update"]);
  });
});

describe("tool server materialization", () => {
  test("newTools on adds new tools without approval; known but unselected tools stay off", () => {
    const server = materializeOrgToolServer({
      server: CRM,
      effective: {
        config: OrgAgentVersionConfig.parse({
          toolServers: [{ server: "crm", tools: { enabled: ["lookup"] }, newTools: "on" }],
        }).toolServers[0]!,
        disableTools: [],
      },
      catalogNames: ["lookup", "delete"],
      liveNames: ["lookup", "delete", "export"],
    });
    expect(server).toEqual({
      id: "crm",
      name: "CRM",
      url: CRM.url,
      allowedTools: ["lookup", "export"],
    });
  });

  test("without a catalog no tool counts as new", () => {
    const server = materializeOrgToolServer({
      server: CRM,
      effective: {
        config: OrgAgentVersionConfig.parse({
          toolServers: [{ server: "crm", tools: { enabled: ["lookup"] }, newTools: "on" }],
        }).toolServers[0]!,
        disableTools: [],
      },
      catalogNames: null,
      liveNames: ["lookup", "export"],
    });
    expect(server.allowedTools).toEqual(["lookup"]);
  });

  test("built-ins merge per capability", () => {
    expect(
      mergeOrgAgentCapabilities({ from: "all", webSearch: false }, { from: "all", media: false }),
    ).toEqual({
      from: "all",
      webSearch: false,
      media: false,
    });
    expect(mergeOrgAgentCapabilities({ from: "all", webSearch: false }, "none")).toBe("none");
    expect(mergeOrgAgentCapabilities("all", { from: "all", browser: false })).toEqual({
      from: "all",
      browser: false,
    });
    expect(mergeOrgAgentCapabilities({ from: "all" }, { from: "none", goals: true })).toEqual({
      from: "none",
      goals: true,
    });
  });
});

describe("config hash and logins", () => {
  test("the config hash is canonical and changes with the config", () => {
    const left = OrgAgentDefinition.parse({
      name: "Support",
      instructions: "Be kind.",
      config: { model: "gpt-5", toolServers: [{ server: "crm" }] },
    });
    const right = OrgAgentDefinition.parse({
      config: { toolServers: [{ server: "crm" }], model: "gpt-5" },
      instructions: "Be kind.",
      name: "Support",
    });
    expect(orgAgentConfigHash(left)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(orgAgentConfigHash(left)).toBe(orgAgentConfigHash(right));
    expect(orgAgentConfigHash({ ...left, instructions: "Be brief." })).not.toBe(
      orgAgentConfigHash(left),
    );
  });

  test("stored logins become request headers", () => {
    expect(
      endUserLoginHeaders(JSON.stringify({ kind: "headers", headers: { "X-Key": "k", n: 1 } })),
    ).toEqual({
      "X-Key": "k",
    });
    expect(
      endUserLoginHeaders(
        JSON.stringify({ kind: "oauth", accessToken: "tok", tokenType: "bearer" }),
      ),
    ).toEqual({ Authorization: "Bearer tok" });
    expect(endUserLoginHeaders(JSON.stringify({ kind: "oauth", accessToken: "tok" }))).toEqual({
      Authorization: "Bearer tok",
    });
    expect(
      endUserLoginHeaders(JSON.stringify({ kind: "oauth", accessToken: "tok", tokenType: "MAC" })),
    ).toEqual({ Authorization: "MAC tok" });
    expect(endUserLoginHeaders("not json")).toBeNull();
    expect(endUserLoginHeaders(JSON.stringify({ kind: "oauth" }))).toBeNull();
  });
});

describe("publish move plan", () => {
  type Row = OrgAgentMoveServerRow;
  const servers: Row[] = [
    {
      id: "crm",
      name: "CRM",
      url: CRM.url,
      allowedTools: ["update"],
      requireApproval: ["update"],
      headersEncrypted: { Authorization: "encrypted-chat-login" },
    },
    { id: "docs", name: "Docs", url: DOCS.url, allowedTools: null },
    { id: "mine", name: null, url: "https://mine.example.com/mcp", headersEncrypted: { k: "v" } },
  ];
  const tools: ToolRef[] = [
    { kind: "mcp", id: "crm", eager: ["lookup"] },
    { kind: "mcp", id: "docs" },
    { kind: "mcp", id: "mine" },
  ];
  const toConfig = OrgAgentVersionConfig.parse({
    model: "claude-x",
    toolServers: [
      { server: "crm", tools: { enabled: ["lookup", "update", "export"] } },
      { server: "billing", tools: { mode: "all" } },
    ],
  });
  const overrides = {
    "toolServers.crm": {
      agent: OrgAgentVersionConfig.parse(VERSION).toolServers[0],
      chat: { disableTools: ["lookup"] },
    },
    "mcpServers.mine": { agent: null, chat: { id: "mine", url: "https://mine.example.com/mcp" } },
    model: { agent: "gpt-5", chat: "claude-x" },
    instructions: { agent: null, chat: "Answer in Norwegian." },
  };

  test("re-materializes the agent's servers, keeps the chat's, re-applies its changes", () => {
    const result = planOrgAgentSessionMove({
      currentServers: servers,
      currentTools: tools,
      fromConfig: OrgAgentVersionConfig.parse(VERSION),
      toConfig,
      toToolCatalog: {},
      toolServers: new Map([CRM, DOCS, BILLING].map((server) => [server.key, server])),
      overrides,
    });
    expect(result.removedServerIds).toEqual(["docs"]);
    expect(result.upsertedServerIds).toEqual(["crm", "billing"]);
    expect(result.servers.map((server) => server.id)).toEqual(["mine", "crm", "billing"]);
    const crm = result.servers.find((server) => server.id === "crm")!;
    // The chat's disabled tool stays off on the new version; its login stays (same URL).
    expect(crm.allowedTools).toEqual(["update", "export"]);
    expect(crm.requireApproval).toBeNull();
    expect(crm.headersEncrypted).toEqual({ Authorization: "encrypted-chat-login" });
    expect(result.servers.find((server) => server.id === "billing")).toMatchObject({
      allowedTools: null,
      headersEncrypted: {},
    });
    expect(result.servers.find((server) => server.id === "mine")?.headersEncrypted).toEqual({
      k: "v",
    });
    expect(result.tools).toEqual([
      { kind: "mcp", id: "crm" },
      { kind: "mcp", id: "mine" },
      { kind: "mcp", id: "billing" },
    ]);
    // The new version has the chat's model: that change no longer differs.
    expect(Object.keys(result.overrides ?? {}).sort()).toEqual([
      "instructions",
      "mcpServers.mine",
      "toolServers.crm",
    ]);
    expect(result.overrides?.["toolServers.crm"]?.agent).toEqual(toConfig.toolServers[0]);
  });

  test("a change that only narrowed the old version narrows the new one", () => {
    // v1: crm selected [lookup, update], ask [update]. The chat narrowed it to
    // [update] and asked first for lookup too.
    const narrowing = {
      "toolServers.crm": {
        agent: OrgAgentVersionConfig.parse(VERSION).toolServers[0],
        chat: {
          tools: { mode: "selected", enabled: ["update"] },
          approval: { ask: ["update", "lookup"] },
        },
      },
    };
    // v2 drops update and asks first for export.
    const next = OrgAgentVersionConfig.parse({
      toolServers: [
        {
          server: "crm",
          tools: { enabled: ["lookup", "export"] },
          approval: { ask: ["export"] },
        },
      ],
    });
    const moved = planOrgAgentSessionMove({
      currentServers: servers,
      currentTools: tools,
      fromConfig: OrgAgentVersionConfig.parse(VERSION),
      toConfig: next,
      toToolCatalog: {},
      toolServers: new Map([CRM].map((server) => [server.key, server])),
      overrides: narrowing,
    });
    const crm = moved.servers.find((server) => server.id === "crm")!;
    // update is no longer the agent's: the chat's selection stays within v2.
    expect(crm.allowedTools).toEqual([]);
    // v2's "Ask first" stays, with the chat's own additions.
    expect(crm.requireApproval).toEqual(["export", "update", "lookup"]);
    expect(moved.overrides?.["toolServers.crm"]?.chat).toEqual({
      tools: { mode: "selected", enabled: [] },
      approval: { ask: ["export", "update", "lookup"] },
    });

    // A widening an organization manager made is applied as recorded.
    const widened = planOrgAgentSessionMove({
      currentServers: servers,
      currentTools: tools,
      fromConfig: OrgAgentVersionConfig.parse(VERSION),
      toConfig: next,
      toToolCatalog: {},
      toolServers: new Map([CRM].map((server) => [server.key, server])),
      overrides: {
        "toolServers.crm": {
          agent: OrgAgentVersionConfig.parse(VERSION).toolServers[0],
          chat: { tools: { mode: "all", enabled: [] }, approval: { ask: [] } },
        },
      },
    });
    const wide = widened.servers.find((server) => server.id === "crm")!;
    expect(wide.allowedTools).toBeNull();
    expect(wide.requireApproval).toBeNull();
  });

  test("a server whose URL changed drops the chat's login", () => {
    const moved = { ...CRM, url: "https://crm-v2.example.com/mcp" };
    const result = planOrgAgentSessionMove({
      currentServers: servers,
      currentTools: tools,
      fromConfig: OrgAgentVersionConfig.parse(VERSION),
      toConfig,
      toToolCatalog: {},
      toolServers: new Map([moved, DOCS, BILLING].map((server) => [server.key, server])),
      overrides: null,
    });
    const crm = result.servers.find((server) => server.id === "crm")!;
    expect(crm.url).toBe(moved.url);
    expect(crm.headersEncrypted).toEqual({});
    expect(result.overrides).toBeNull();
  });
});

describe("chats without an organization agent", () => {
  test("today's agent field never enters the organization agent path", () => {
    for (const agent of [
      undefined,
      null,
      {},
      { capabilities: "all" },
      { capabilities: { from: "none", webSearch: true } },
      { identity: "You are Bob.", instructions: "Be brief.", renderer: "markdown" },
      { titleInstructions: null, vaultPolicy: { mode: "none" } },
      [],
      42,
    ]) {
      expect(sessionAgentFieldNamesOrgAgent(agent)).toBe(false);
    }
    expect(sessionAgentFieldNamesOrgAgent("support")).toBe(true);
    expect(sessionAgentFieldNamesOrgAgent({ ref: "support" })).toBe(true);
  });
});
