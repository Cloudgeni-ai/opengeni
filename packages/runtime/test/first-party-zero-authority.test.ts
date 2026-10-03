import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { MCPServer } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AttemptToolNotFoundError } from "@opengeni/codemode";
import type { Settings } from "@opengeni/config";
import {
  AutomationSessionTemplate,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DelegatedAccessTokenPayload,
  signDelegatedAccessToken,
  verifyDelegatedAccessToken,
  type Permission,
  type ToolAuthNeededPayload,
  type ToolRef,
} from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { withFirstPartyTools } from "../../../apps/worker/src/activities/goals";
import { prepareAgentTools, type PrepareToolsOptions, type PreparedAgentTools } from "../src/index";

// Run this focused seam in its own Bun invocation. No module/global mocks,
// listening sockets, model calls, worker activities, or real credentials.
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const secret = "test-delegation-secret";
const firstPartyUrl = "http://127.0.0.1:41872/v1/workspaces/{workspaceId}/mcp";
const objectSchema = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
  additionalProperties: false,
};

function settingsFor(
  servers: Settings["mcpServers"] = [{ id: "opengeni", url: firstPartyUrl, cacheToolsList: false }],
) {
  return testSettings({
    sandboxBackend: "none",
    delegationSecret: secret,
    opengeniMcpUrl: firstPartyUrl,
    opengeniMcpInternalUrl: firstPartyUrl,
    mcpServers: servers,
    integrationsAllowPrivateNetworkTargets: true,
  });
}

function forbiddenTransport() {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    fetch: async () => {
      requests++;
      throw new Error("zero-authority startup must not request MCP transport");
    },
  };
}

async function expectAbsent(prepared: PreparedAgentTools, serverId = "opengeni") {
  expect(prepared.mcpServers).toEqual([]);
  expect(prepared.attemptToolCatalog?.entries).toEqual([]);
  expect(prepared.ready).toBeUndefined();
  const environment = prepared.attemptToolEnvironment!;
  expect(environment).not.toBeNull();
  await expect(
    environment.prepareCall({
      operationId: crypto.randomUUID(),
      catalogDigest: environment.catalog.digest,
      identity: { serverId, toolName: "session_get" },
      arguments: {},
      caller: { kind: "codemode", subjectId: "fixture" },
    }),
  ).rejects.toBeInstanceOf(AttemptToolNotFoundError);
  await expect(
    environment.callModel({
      modelName: `${serverId}__session_get`,
      arguments: {},
      subjectId: "fixture",
    }),
  ).rejects.toBeInstanceOf(AttemptToolNotFoundError);
}

// Real MCP protocol adapter, but entirely in memory. The injected final fetch
// captures credentials without DNS/network/provider/service dispatch.
function protocolTransport() {
  const authorizations: Array<string | null> = [];
  const methods: string[] = [];
  const servers: McpServer[] = [];
  let calls = 0;
  return {
    authorizations,
    methods,
    get calls() {
      return calls;
    },
    fetch: async (
      input: Parameters<NonNullable<PrepareToolsOptions["mcpFetchImpl"]>>[0],
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      authorizations.push(request.headers.get("authorization"));
      if (request.method === "POST") {
        const body = (await request.clone().json()) as { method?: string };
        if (body.method) methods.push(body.method);
      }
      const server = new McpServer({ name: "zero-authority-fixture", version: "1.0.0" });
      server.registerTool("session_get", { inputSchema: {} }, async () => {
        calls++;
        return { content: [{ type: "text", text: "fixture response" }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      servers.push(server);
      await server.connect(transport);
      return await transport.handleRequest(request);
    },
    close: async () => {
      await Promise.all(servers.map((server) => server.close()));
    },
  };
}

test("package imports resolve this worktree's actual source modules", () => {
  for (const [name, path] of [
    ["@opengeni/runtime", "../src/index.ts"],
    ["@opengeni/contracts", "../../contracts/src/index.ts"],
    ["@opengeni/config", "../../config/src/index.ts"],
    ["@opengeni/testing", "../../testing/src/index.ts"],
  ]) {
    expect(realpathSync(new URL(import.meta.resolve(name!)))).toBe(
      realpathSync(new URL(path!, import.meta.url)),
    );
  }
});

describe.each(["omitted", "explicit"] as const)("automation %s empty permissions", (selection) => {
  test.each([
    { name: "automatic attachment", ref: undefined },
    { name: "required", ref: { kind: "mcp", id: "opengeni" } as ToolRef },
    { name: "required eager", ref: { kind: "mcp", id: "opengeni", eager: true } as ToolRef },
    { name: "deferred", ref: { kind: "mcp", id: "opengeni" } as ToolRef, deferred: true },
    {
      name: "optional input merged strict eager deferred",
      ref: { kind: "mcp", id: "opengeni", optional: true, eager: true } as ToolRef,
      deferred: true,
    },
  ])("$name skips delegated MCP before token validation or fetch", async ({ ref, deferred }) => {
    const template = AutomationSessionTemplate.parse({
      prompt: "Summarize a synthetic report.",
      ...(ref ? { tools: [ref] } : {}),
      ...(selection === "explicit" ? { firstPartyMcpTools: [], firstPartyMcpPermissions: [] } : {}),
    });
    expect(template.firstPartyMcpPermissions).toEqual([]);
    expect(template.firstPartyMcpTools).toEqual([]);
    const settings = settingsFor();
    const refs = withFirstPartyTools(settings, template.tools);
    // Worker augmentation preserves strict/eager merging, not optionality.
    expect(refs).toEqual([{ kind: "mcp", id: "opengeni", ...(ref?.eager ? { eager: true } : {}) }]);
    const transport = forbiddenTransport();
    const notices: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(settings, refs, {
      ...scope,
      firstPartyPermissions: template.firstPartyMcpPermissions,
      firstPartyTools: template.firstPartyMcpTools,
      ...(deferred ? { deferNonEagerUntilToolDemand: true } : {}),
      mcpFetchImpl: transport.fetch,
      onAuthNeeded: (notice) => {
        notices.push(notice);
      },
    });
    try {
      await expectAbsent(prepared);
      expect(transport.requests).toBe(0);
      expect(notices).toEqual([]);
      expect(template.firstPartyMcpPermissions).toEqual([]);
    } finally {
      await prepared.close();
    }
    expect(transport.requests).toBe(0);
  });
});

test("optional remote first-party input also skips before deferred preparation", async () => {
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(
    settingsFor(),
    [{ kind: "mcp", id: "opengeni", optional: true, eager: true }],
    {
      ...scope,
      firstPartyPermissions: [],
      firstPartyTools: [],
      deferNonEagerUntilToolDemand: true,
      mcpFetchImpl: transport.fetch,
    },
  );
  try {
    await expectAbsent(prepared);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test("zero-authority startup never consults delegated-token signing material", async () => {
  const settings = settingsFor();
  let signingMaterialReads = 0;
  Object.defineProperty(settings, "delegationSecret", {
    enumerable: true,
    get() {
      signingMaterialReads++;
      throw new Error("zero-authority startup must not enter delegated-token preparation");
    },
  });
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(settings, withFirstPartyTools(settings, []), {
    ...scope,
    firstPartyPermissions: [],
    firstPartyTools: [],
    mcpFetchImpl: transport.fetch,
  });
  try {
    await expectAbsent(prepared);
    expect(signingMaterialReads).toBe(0);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test("zero authority does not fall back to static access-key or unauthenticated local requests", async () => {
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(
    {
      ...settingsFor(),
      delegationSecret: undefined,
      authRequired: true,
      accessKey: "synthetic-access-key",
    },
    [{ kind: "mcp", id: "opengeni" }],
    {
      ...scope,
      firstPartyPermissions: [],
      firstPartyTools: [],
      mcpFetchImpl: transport.fetch,
    },
  );
  try {
    await expectAbsent(prepared);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test.each(["opengeni", "files", "docs"])(
  "requested %s stays absent/denied with a safe scope advisory",
  async (id) => {
    const settings = settingsFor([{ id, url: firstPartyUrl, cacheToolsList: false }]);
    const transport = forbiddenTransport();
    const notices: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id, eager: true }], {
      ...scope,
      firstPartyPermissions: [],
      firstPartyTools: id === "opengeni" ? ["session_get"] : [],
      mcpFetchImpl: transport.fetch,
      onAuthNeeded: (notice) => {
        notices.push(notice);
      },
    });
    try {
      await expectAbsent(prepared, id);
      expect(notices).toEqual([
        { serverId: id, providerDomain: "opengeni", reason: "insufficient_scope" },
      ]);
      expect(transport.requests).toBe(0);
    } finally {
      await prepared.close();
    }
  },
);

test("undefined first-party tool selection still requests the default catalog and gets an advisory", async () => {
  const notices: ToolAuthNeededPayload[] = [];
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(settingsFor(), [{ kind: "mcp", id: "opengeni" }], {
    ...scope,
    firstPartyPermissions: [],
    mcpFetchImpl: transport.fetch,
    onAuthNeeded: (notice) => {
      notices.push(notice);
    },
  });
  try {
    await expectAbsent(prepared);
    expect(notices).toEqual([
      { serverId: "opengeni", providerDomain: "opengeni", reason: "insufficient_scope" },
    ]);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test("advisory failure cannot turn zero authority into a startup failure or a transport request", async () => {
  const transport = forbiddenTransport();
  let notices = 0;
  const prepared = await prepareAgentTools(settingsFor(), [{ kind: "mcp", id: "opengeni" }], {
    ...scope,
    firstPartyPermissions: [],
    firstPartyTools: ["session_get"],
    mcpFetchImpl: transport.fetch,
    onAuthNeeded: () => {
      notices++;
      throw new Error("synthetic advisory failure");
    },
  });
  try {
    await expectAbsent(prepared);
    expect(notices).toBe(1);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test("a linked effective permission intersection of [] is not replaced by the session grant", async () => {
  const sessionPermissions: Permission[] = ["sessions:read"];
  const linkedPermissions: Permission[] = ["files:read"];
  // Exact pure intersection used by worker tool-environment preparation. This
  // does not exercise the DB-backed identity-link authorization itself.
  const effective = sessionPermissions.filter((permission) =>
    hasPermission(linkedPermissions, permission),
  );
  expect(effective).toEqual([]);
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(settingsFor(), withFirstPartyTools(settingsFor(), []), {
    ...scope,
    firstPartyPermissions: effective,
    firstPartyTools: [],
    mcpFetchImpl: transport.fetch,
  });
  try {
    await expectAbsent(prepared);
    expect(transport.requests).toBe(0);
    expect(sessionPermissions).toEqual(["sessions:read"]);
  } finally {
    await prepared.close();
  }
});

test.each(["explicit", "undefined"] as const)(
  "%s nonzero permissions retain actual delegated-token startup",
  async (selection) => {
    const transport = protocolTransport();
    const prepared = await prepareAgentTools(
      settingsFor(),
      [{ kind: "mcp", id: "opengeni", eager: true }],
      {
        ...scope,
        ...(selection === "explicit"
          ? { firstPartyPermissions: ["sessions:read"] as Permission[] }
          : {}),
        firstPartyTools: ["session_get"],
        mcpFetchImpl: transport.fetch,
      },
    );
    try {
      expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
        "opengeni__session_get",
      ]);
      await prepared.mcpServers[0]!.callTool("opengeni__session_get", {});
      expect(transport.calls).toBe(1);
      expect(transport.methods).toContain("initialize");
      expect(transport.methods).toContain("tools/list");
      expect(transport.methods).toContain("tools/call");
      for (const authorization of transport.authorizations) {
        expect(authorization).toStartWith("Bearer ");
        const payload = await verifyDelegatedAccessToken(secret, authorization!.slice(7));
        expect(payload).toMatchObject({
          ...scope,
          principalKind: "agent_attempt",
          firstPartyMcpTools: ["session_get"],
        });
        expect(payload!.permissions).toEqual(
          selection === "explicit" ? ["sessions:read"] : [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
        );
      }
    } finally {
      await prepared.close();
      await transport.close();
    }
  },
);

test.each(["opengeni", "files", "docs"])(
  "external-host %s id is not delegated first-party authority",
  async (id) => {
    const transport = protocolTransport();
    const prepared = await prepareAgentTools(
      settingsFor([{ id, url: "http://127.0.0.1:41873/product/mcp", cacheToolsList: false }]),
      [{ kind: "mcp", id }],
      {
        ...scope,
        firstPartyPermissions: [],
        firstPartyTools: [],
        mcpFetchImpl: transport.fetch,
      },
    );
    try {
      expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
        `${id}__session_get`,
      ]);
      await prepared.mcpServers[0]!.callTool(`${id}__session_get`, {});
      expect(transport.calls).toBe(1);
      expect(transport.authorizations.length).toBeGreaterThan(0);
      expect(transport.authorizations.every((authorization) => authorization === null)).toBe(true);
    } finally {
      await prepared.close();
      await transport.close();
    }
  },
);

test("host-owned local registration matching first-party config retains independent execution", async () => {
  let calls = 0;
  let closes = 0;
  const server: MCPServer = {
    name: "host-owned",
    cacheToolsList: false,
    async connect() {},
    async close() {
      closes++;
    },
    async listTools() {
      return [{ name: "session_get", inputSchema: objectSchema }];
    },
    async callTool() {
      calls++;
      return [{ type: "text", text: "host result" }];
    },
    async invalidateToolsCache() {},
  };
  const transport = forbiddenTransport();
  const prepared = await prepareAgentTools(settingsFor(), [{ kind: "mcp", id: "opengeni" }], {
    ...scope,
    firstPartyPermissions: [],
    firstPartyTools: [],
    localMcpServers: [{ id: "opengeni", server }],
    mcpFetchImpl: transport.fetch,
  });
  try {
    expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
      "opengeni__session_get",
    ]);
    await prepared.mcpServers[0]!.callTool("opengeni__session_get", {});
    expect(calls).toBe(1);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
  expect(closes).toBe(1);
});

test("connectionRef on matching first-party config retains its independently authorized broker", async () => {
  const transport = protocolTransport();
  const connectionId = "66666666-6666-4666-8666-666666666666";
  let resolutions = 0;
  let physicalChecks = 0;
  let admissions = 0;
  const notices: ToolAuthNeededPayload[] = [];
  const prepared = await prepareAgentTools(
    settingsFor([
      {
        id: "opengeni",
        url: firstPartyUrl,
        cacheToolsList: false,
        connectionRef: { connectionId, providerDomain: "127.0.0.1" },
      },
    ]),
    [{ kind: "mcp", id: "opengeni" }],
    {
      ...scope,
      firstPartyPermissions: [],
      firstPartyTools: [],
      mcpFetchImpl: transport.fetch,
      resolveCredential: async () => {
        resolutions++;
        return {
          status: "ok",
          connectionId,
          headers: { authorization: "Bearer synthetic-independent-connection" },
          authorizeProviderRequest: async () => {
            physicalChecks++;
            return true;
          },
        };
      },
      onAuthNeeded: (notice) => {
        notices.push(notice);
      },
      connectorActionPolicy: {
        prepare: async () => ({ managed: false, decision: "unmanaged" }),
        begin: async () => {
          admissions++;
          return { allowed: true, managed: false };
        },
        complete: async () => {},
      },
    },
  );
  try {
    expect(prepared.resolvedMcpConnectionIds.get("opengeni")).toBe(connectionId);
    expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
      "opengeni__session_get",
    ]);
    await prepared.mcpServers[0]!.callTool("opengeni__session_get", {});
    expect(transport.calls).toBe(1);
    expect(resolutions).toBeGreaterThan(0);
    expect(physicalChecks).toBeGreaterThan(0);
    expect(admissions).toBe(1);
    expect(
      transport.authorizations.every(
        (authorization) => authorization === "Bearer synthetic-independent-connection",
      ),
    ).toBe(true);
    expect(notices).toEqual([]);
  } finally {
    await prepared.close();
    await transport.close();
  }
});

test("already-authorized native attempt mechanics survive the skipped remote server", async () => {
  const transport = forbiddenTransport();
  let calls = 0;
  let authorizations = 0;
  const prepared = await prepareAgentTools(settingsFor(), withFirstPartyTools(settingsFor(), []), {
    ...scope,
    firstPartyPermissions: [],
    firstPartyTools: [],
    mcpFetchImpl: transport.fetch,
    attemptToolDefinitions: [
      {
        identity: { serverId: "runtime", toolName: "session_set_title" },
        modelName: "session_set_title",
        inputSchema: objectSchema,
        source: "mcp",
        approval: "none",
        execute: async () => {
          calls++;
          return { content: [{ type: "text", text: "native result" }] };
        },
      },
    ],
    attemptToolAuthorize: async () => {
      authorizations++;
    },
  });
  try {
    expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
      "session_set_title",
    ]);
    await prepared.attemptToolEnvironment!.callModel({
      modelName: "session_set_title",
      arguments: {},
      subjectId: "fixture",
    });
    expect(calls).toBe(1);
    expect(authorizations).toBe(1);
    expect(transport.requests).toBe(0);
  } finally {
    await prepared.close();
  }
});

test("delegated token min1 remains unchanged; [] is never a valid signed grant", async () => {
  const payload = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: "fixture:service",
    principalKind: "service" as const,
    permissions: [] as Permission[],
    firstPartyMcpTools: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const result = DelegatedAccessTokenPayload.safeParse(payload);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ code: "too_small", minimum: 1, path: ["permissions"] }),
    );
  }
  await expect(signDelegatedAccessToken(secret, payload)).rejects.toThrow();
  const token = await signDelegatedAccessToken(secret, {
    ...payload,
    permissions: ["sessions:read"],
  });
  expect((await verifyDelegatedAccessToken(secret, token))?.permissions).toEqual(["sessions:read"]);
});
