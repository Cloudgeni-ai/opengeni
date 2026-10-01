// The agent-configuration examples in the opengeni-client Skill and the docs,
// compiled against the real SDK types. Keep the snippets in
// `.agents/skills/opengeni-client/references/configure-the-agent.md`,
// `docs/product-integration.md` and `docs-site/integrate/configure-the-agent.mdx`
// in step with this file: if it stops type-checking, the docs are wrong.
import { describe, expect, test } from "bun:test";

import { OpenGeni, createChatHandler } from "../src/chat";
import { OpenGeniClient } from "../src/index";
import { OpenGeniSetupError } from "../src/errors";
import { createSessionProxyHandler } from "../src/session-proxy";
import { createWorkspaceIdResolver } from "../src/tenant-workspaces";
import type { AgentConfigRequest, CreateSessionRequest } from "../src/types";

// Placeholder environment so the module-level clients construct; nothing is called.
process.env.OPENGENI_API_BASE_URL ??= "https://opengeni.example.test";
process.env.OPENGENI_API_KEY ??= "ogk_example";
process.env.OPENGENI_ORGANIZATION_ID ??= "00000000-0000-4000-8000-000000000000";

declare const authenticate: (
  request: Request,
) => Promise<{ id: string; orgId: string; openGeniWorkspaceId: string } | null>;
declare const ACME_MCP_URL: string;
declare const mintUserToken: (user: string) => Promise<string>;

// 1. Inspect before changing anything.
async function inspect(og: OpenGeniClient, workspaceId: string, sessionId: string) {
  const config = await og.getClientConfig();
  const admitted = config.agentConfig?.enabled === true; // false: send no `agent` yet
  const offered = (config.agentConfig?.capabilities ?? [])
    .filter((capability) => capability.available)
    .map((capability) => capability.id);
  const workspace = await og.getWorkspace(workspaceId);
  const defaults = workspace.settings.sessionAgentDefaults; // null/undefined: OpenGeni's defaults
  const session = await og.getSession(workspaceId, sessionId);
  // session.agent: the frozen configuration (null for sessions created before it).
  // session.effectiveTools: the tools it can use, with upfront or on-demand visibility.
  return { admitted, offered, defaults, agent: session.agent, tools: session.effectiveTools };
}

// 2. One agent object: capabilities, identity, instructions, renderer.
const assistant: AgentConfigRequest = {
  identity: "You are Acme Analytics' assistant. You help customers read their dashboards.",
  instructions: "Lead with the number, then one sentence of context.",
  capabilities: { from: "none", webSearch: true, knowledge: true },
  renderer: "opengeni", // "markdown" when your own UI renders plain Markdown
};

async function createAssistantSession(og: OpenGeniClient, workspaceId: string, message: string) {
  return await og.createSession(workspaceId, {
    initialMessage: message,
    idempotencyKey: crypto.randomUUID(),
    agent: assistant,
    sandboxBackend: "none",
  });
}

// 3. The session proxy: private chats and a server-chosen agent.
const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});
const acme = (token: string) => ({ id: "acme", headers: { Authorization: `Bearer ${token}` } });
const proxy = createSessionProxyHandler(og, {
  chats: "private", // the default; "shared" or "isolated"
  resolve: async (request) => {
    const me = await authenticate(request);
    return me
      ? { workspaceId: me.openGeniWorkspaceId, user: me.id, source: "acme-app" }
      : new Response("Unauthorized", { status: 401 });
  },
  createSession: async ({ initialMessage, idempotencyKey }, { user }) =>
    ({
      initialMessage,
      idempotencyKey,
      agent: { ...assistant, capabilities: "none" }, // only Acme's tools plus the essentials
      mcpServers: [{ ...acme(await mintUserToken(user)), url: ACME_MCP_URL }],
      tools: [{ kind: "mcp", id: "acme" }],
      sandboxBackend: "none",
    }) satisfies CreateSessionRequest,
});

// 4. Isolated chats: a workspace per tenant user, through the facade.
const facade = new OpenGeni({
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  source: "acme-app",
});
const isolatedProxy = createSessionProxyHandler(facade, {
  chats: "isolated",
  resolve: async (request) => {
    const me = await authenticate(request);
    return me ? { tenant: me.orgId, user: me.id } : new Response("Unauthorized", { status: 401 });
  },
});
async function isolatedWorkspace(tenant: string, user: string) {
  return await facade.workspaceIdFor({ tenant, user }, { isolation: "user" });
}
const resolveWorkspace = createWorkspaceIdResolver(og, {
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
  source: "acme-app",
});

// 5. The chat facade: private chats per user, markdown by default.
async function facadeChat(tenant: string, user: string, text: string) {
  try {
    const chat = await facade.chat({
      tenant,
      user,
      conversation: `support:${user}`,
      chats: "private",
      agent: { identity: assistant.identity!, capabilities: "none" },
    });
    return await chat.send(text);
  } catch (error) {
    if (error instanceof OpenGeniSetupError) {
      // Private chats need the organization's private-session setting; the
      // message names who can turn it on and where.
      throw error;
    }
    throw error;
  }
}

const chatEndpoint = createChatHandler(facade, {
  resolve: async (request) => {
    const me = await authenticate(request);
    return me
      ? {
          tenant: me.orgId,
          user: me.id,
          chats: "private",
          agent: {
            identity: "You are Acme's assistant.",
            capabilities: { from: "none", webSearch: true },
          },
        }
      : new Response("Unauthorized", { status: 401 });
  },
  format: "vercel",
});

// 6. Workspace defaults, schedules, and a change in a running session.
async function workspaceDefaultsAndSchedules(workspaceId: string, sessionId: string) {
  await og.updateWorkspaceSettings(workspaceId, {
    sessionAgentDefaults: {
      capabilities: { from: "all", browser: false, workspaceAdmin: false },
      identity: "You are Acme's operations agent.",
    },
  });
  await og.createScheduledTask(workspaceId, {
    name: "Morning digest",
    schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
    agentConfig: {
      prompt: "Summarize yesterday's new tickets and flag anything urgent.",
      agent: { capabilities: { from: "none", knowledge: true } },
      tools: [{ kind: "mcp", id: "acme" }],
    },
  });
  const session = await og.getSession(workspaceId, sessionId);
  await og.updateSessionAgent(workspaceId, sessionId, {
    agent: { capabilities: { from: "all", webSearch: false } },
    expectedVersion: session.toolPolicyVersion, // 409 when someone changed it first
  });
}

describe("agent configuration docs examples", () => {
  test("compile against the SDK", () => {
    expect(typeof inspect).toBe("function");
    expect(typeof createAssistantSession).toBe("function");
    expect(typeof proxy).toBe("function");
    expect(typeof isolatedProxy).toBe("function");
    expect(typeof isolatedWorkspace).toBe("function");
    expect(typeof resolveWorkspace).toBe("function");
    expect(typeof facadeChat).toBe("function");
    expect(typeof chatEndpoint).toBe("function");
    expect(typeof workspaceDefaultsAndSchedules).toBe("function");
  });
});
