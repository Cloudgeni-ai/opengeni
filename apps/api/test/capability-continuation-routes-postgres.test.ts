import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  FIKEN_CREDENTIAL_LABEL,
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  FIRST_PARTY_MCP_TOOL_NAMES,
  signDelegatedAccessToken,
  type Permission,
  type Session,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createConnection,
  createDb,
  installApiIntegration,
  createOrganizationApiKey,
  encryptEnvironmentValue,
  listSessionSystemUpdatesForTurn,
  peekSessionWork,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// After a person finishes setup from the agent's capability card, the client
// asks the chat to continue. Through the real HTTP app and PostgreSQL in the
// production posture: who may ask, when the capability counts as usable in
// the chat, the wake, and at most one continuation per card.
setDefaultTimeout(120_000);
const SECRET = "capability-continuation-api-secret";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");
let shared: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("capability-continuation-api");
  if (!acquired) throw new Error("Capability continuation API tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

class WorkflowRecorder implements SessionWorkflowClient {
  calls: string[] = [];
  async signalUserMessage(): Promise<void> {
    this.calls.push("signalUserMessage");
  }
  async wakeSessionWorkflow(): Promise<void> {
    this.calls.push("wakeSessionWorkflow");
  }
  async requestSessionWorkflowWakeDispatch(): Promise<void> {
    this.calls.push("requestSessionWorkflowWakeDispatch");
  }
  async signalApprovalDecision(): Promise<void> {
    this.calls.push("signalApprovalDecision");
  }
  async signalSessionControl(): Promise<void> {
    this.calls.push("signalSessionControl");
  }
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

const PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
];

const FIKEN_TOOLS = FIRST_PARTY_MCP_TOOL_NAMES.filter((name) => name.startsWith("fiken_"));

async function fixture() {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Capability continuation API') returning id`;
  const accountId = account!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}, 'Capability continuation API') returning id`;
  const workspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  const token = `ogk_${crypto.randomUUID()}`;
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Capability continuation host",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: PERMISSIONS,
  });
  const workflow = new WorkflowRecorder();
  const app = createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: SECRET,
      sandboxBackend: "none",
      environmentsEncryptionKey: ENCRYPTION_KEY,
      // Microsoft sign-in configured, so reviewed Microsoft integrations are connectable.
      integrationsEnabled: true,
      integrationsStateSecret: "capability-continuation-integrations-state",
      integrationsOauthClientsJson: JSON.stringify({
        "https://login.microsoftonline.com/common/v2.0": {
          clientId: "microsoft-client",
          clientSecret: "microsoft-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      }),
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: workflow,
    objectStorage: null,
    githubStateSecret: "capability-continuation-test",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("unused");
    },
    resumeBoxById: async () => {
      throw new Error("unused");
    },
  } as unknown as ApiRouteDeps);
  return {
    accountId,
    workspaceId,
    workflow,
    app,
    host: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function sessionsPath(f: Fixture, suffix = "") {
  return `/v1/workspaces/${f.workspaceId}/sessions${suffix}`;
}

async function agentBearer(f: Fixture, sessionId: string) {
  const token = await signDelegatedAccessToken(SECRET, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: "user:capability-continuation:agent",
    subjectLabel: "agent",
    principalKind: "agent_attempt",
    permissions: PERMISSIONS,
    sessionId,
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function claim(f: Fixture, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.action}`);
  return { turn: claimed.turn, attemptId };
}

async function settle(
  f: Fixture,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claim>>,
  started: boolean,
) {
  const settled = await applySessionTurnSettlement(client.db, f.workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: started ? "running" : "completed",
    sessionStatus: started ? "running" : "idle",
    activeTurnId: started ? claimed.turn.id : null,
    events: started
      ? [{ type: "turn.started", payload: { turnId: claimed.turn.id } }]
      : [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

const FIKEN_CARD = {
  providerDomain: FIKEN_PROVIDER_DOMAIN,
  capability: {
    id: "api:fiken",
    name: "Fiken",
    kind: "api",
    source: "built_in",
    action: "connect",
    rationale: "Sending the invoice needs Fiken.",
    requiredVariables: [],
  },
};

/** The agent asks for a capability (Fiken by default) with a connect card and ends its turn. */
async function idleSessionWithFikenCard(f: Fixture, card: typeof FIKEN_CARD = FIKEN_CARD) {
  const created = await f.app.request(sessionsPath(f), {
    method: "POST",
    headers: f.host,
    body: JSON.stringify({ initialMessage: "send the invoice", model: "scripted-model" }),
  });
  expect(created.status, await created.clone().text()).toBe(202);
  const session = (await created.json()) as Session;
  const first = await claim(f, session.id);
  await settle(f, session.id, first, true);
  await appendSessionEventsForTurnAttempt(
    client.db,
    f.workspaceId,
    session.id,
    first.turn.id,
    first.turn.executionGeneration,
    first.attemptId,
    [
      {
        type: "tool.auth_needed",
        payload: {
          serverId: "opengeni",
          toolName: "capability_authorization_request",
          providerDomain: card.providerDomain,
          reason: "missing_connection",
          capability: card.capability,
        },
      },
    ],
  );
  await settle(f, session.id, first, false);
  return session;
}

async function continueAfterSetup(
  f: Fixture,
  sessionId: string,
  capabilityId: string,
  headers: Record<string, string> = f.host,
) {
  return await f.app.request(sessionsPath(f, `/${sessionId}/capability-continuations`), {
    method: "POST",
    headers,
    body: JSON.stringify({ capabilityId }),
  });
}

async function connectFiken(f: Fixture) {
  await createConnection(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: null,
    providerDomain: FIKEN_PROVIDER_DOMAIN,
    kind: "api_key",
    credentialEncrypted: encryptEnvironmentValue(
      Buffer.from(ENCRYPTION_KEY, "base64"),
      JSON.stringify({ headers: { authorization: "Bearer fiken-test" } }),
    ),
    grantedScopes: [],
    expiresAt: null,
    // The verified install route's metadata.
    metadata: {
      credentialRole: FIKEN_CREDENTIAL_ROLE,
      credentialLabel: FIKEN_CREDENTIAL_LABEL,
      companies: [],
      defaultCompanySlug: null,
      verifiedAt: new Date().toISOString(),
    },
    createdBySubjectId: "subject-capability-continuation",
  });
}

/** What the clients' attach step writes: Fiken's tools selected in this chat. */
async function attachFiken(f: Fixture, sessionId: string) {
  const read = await f.app.request(sessionsPath(f, `/${sessionId}`), { headers: f.host });
  const session = (await read.json()) as Session;
  const response = await f.app.request(sessionsPath(f, `/${sessionId}/tool-policy`), {
    method: "PUT",
    headers: f.host,
    body: JSON.stringify({
      mode: "explicit",
      tools: session.tools.filter(
        (tool) => !session.effectiveToolPolicy?.mandatoryIds.includes(tool.id),
      ),
      firstPartyMcpTools: [...new Set([...session.firstPartyMcpTools, ...FIKEN_TOOLS])],
      expectedVersion: session.toolPolicyVersion,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("capability continuation API", () => {
  test("continues once after the capability is usable in the chat, and wakes the session", async () => {
    const f = await fixture();
    const session = await idleSessionWithFikenCard(f);
    const wakes = () => f.workflow.calls.filter((call) => call === "wakeSessionWorkflow").length;
    const wakesBefore = wakes();

    // Not connected yet: nothing is sent.
    const early = await continueAfterSetup(f, session.id, "api:fiken");
    expect(early.status, await early.clone().text()).toBe(200);
    expect(await early.json()).toEqual({ outcome: "not_needed", reason: "not_ready" });

    // Connected, but its tools are not in this chat yet.
    await connectFiken(f);
    const unattached = await continueAfterSetup(f, session.id, "api:fiken");
    expect(await unattached.json()).toEqual({ outcome: "not_needed", reason: "not_ready" });
    expect(wakes()).toBe(wakesBefore);

    await attachFiken(f, session.id);
    const queued = await continueAfterSetup(f, session.id, "api:fiken");
    expect(queued.status, await queued.clone().text()).toBe(200);
    const body = (await queued.json()) as { outcome: string; updateId: string };
    expect(body.outcome).toBe("queued");
    expect(wakes()).toBe(wakesBefore + 1);
    expect(await peekSessionWork(client.db, f.workspaceId, session.id)).toEqual({
      kind: "runnable",
    });

    // Another tab or a retry: the same continuation, no second wake.
    const repeated = await continueAfterSetup(f, session.id, "api:fiken");
    expect(await repeated.json()).toEqual({ outcome: "already_queued", updateId: body.updateId });
    expect(wakes()).toBe(wakesBefore + 1);

    const resumed = await claim(f, session.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      f.workspaceId,
      session.id,
      resumed.turn.id,
    );
    expect(delivered.map((update) => [update.id, update.summary])).toEqual([
      [
        body.updateId,
        "The person finished setting up Fiken from your request. Its tools are now available, so continue the request that needed it.",
      ],
    ]);
  });

  test("cards that report themselves, unknown capabilities and agents send nothing", async () => {
    const f = await fixture();
    const session = await idleSessionWithFikenCard(f);
    const wakesBefore = f.workflow.calls.filter((call) => call === "wakeSessionWorkflow").length;

    const github = await continueAfterSetup(f, session.id, "api:github-app");
    expect(await github.json()).toEqual({ outcome: "not_needed", reason: "not_applicable" });
    const unknown = await continueAfterSetup(f, session.id, "mcp:not-in-the-catalog");
    expect(await unknown.json()).toEqual({ outcome: "not_needed", reason: "not_ready" });

    await connectFiken(f);
    await attachFiken(f, session.id);
    const agent = await continueAfterSetup(
      f,
      session.id,
      "api:fiken",
      await agentBearer(f, session.id),
    );
    expect(agent.status).toBe(403);
    const [pending] = await shared.admin<Array<{ count: string }>>`
      select count(*) from session_system_updates where session_id = ${session.id}`;
    expect(Number(pending!.count)).toBe(0);
    expect(f.workflow.calls.filter((call) => call === "wakeSessionWorkflow")).toHaveLength(
      wakesBefore,
    );
  });

  test("a reviewed integration's card continues once the person's own account is connected", async () => {
    const f = await fixture();
    const session = await idleSessionWithFikenCard(f, {
      providerDomain: "graph.microsoft.com",
      capability: {
        id: "api:integration:microsoft-outlook-mail",
        name: "Outlook Mail",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Reading your newest emails needs Outlook Mail.",
        requiredVariables: [],
      },
    });
    const capabilityId = "api:integration:microsoft-outlook-mail";
    const subjectId = (session.createdBy as { subjectId: string }).subjectId;

    // Nothing connected yet.
    const early = await continueAfterSetup(f, session.id, capabilityId);
    expect(await early.json()).toEqual({ outcome: "not_needed", reason: "not_ready" });

    // What the card's sign-in leaves behind: the person's own Microsoft
    // account and an instance of the reviewed definition bound to it.
    const connection = await createConnection(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId,
      providerDomain: "graph.microsoft.com",
      kind: "oauth2",
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify({ accessToken: "microsoft-test" }),
      ),
      grantedScopes: [],
      expiresAt: null,
      metadata: {},
      createdBySubjectId: subjectId,
    });
    await installApiIntegration(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId,
      capabilityId: "api:microsoft-outlook-mail",
      pluginKey: "integration/microsoft-outlook-mail",
      serverId: "outlook_mail_test",
      name: "Outlook Mail",
      description: "Read mail.",
      category: "integrations",
      tags: ["openapi", "microsoft"],
      definitionId: "microsoft-outlook-mail",
      definitionProvenance: "curated",
      providerDomain: "graph.microsoft.com",
      protocol: "openapi",
      baseUrl: "https://graph.microsoft.com/v1.0/",
      sourceUrl: null,
      authScheme: { kind: "oauth2" },
      connectionId: connection.id,
      requiredScopes: [],
      ownership: "subject",
      revision: {
        id: "openapi:222222222222222222222222",
        protocol: "openapi",
        definitionId: "microsoft-outlook-mail",
        contentSha256: "2".repeat(64),
        source: { url: "https://graph.microsoft.com/v1.0/" },
        title: "Outlook Mail",
        tools: [
          {
            id: "list_messages",
            operationKey: "listMessages",
            name: "List messages",
            description: "List messages.",
            inputSchema: { type: "object", properties: {} },
            safety: "read",
            approvalMode: "never",
            deprecated: false,
          },
        ],
        bindings: {
          list_messages: {
            method: "get",
            pathTemplate: "/me/messages",
            serverUrl: "https://graph.microsoft.com/v1.0/",
            parameters: [],
          },
        },
      },
    } as Parameters<typeof installApiIntegration>[1]);

    const listed = async () =>
      (
        (await (
          await f.app.request(`/v1/workspaces/${f.workspaceId}/integrations`, { headers: f.host })
        ).json()) as {
          integrations: Array<{
            definitionId: string;
            connected: boolean;
            connectionId: string | null;
            ownership: string;
          }>;
        }
      ).integrations.find((instance) => instance.definitionId === "microsoft-outlook-mail");

    // An expired or revoked sign-in is not connected: the card reconnects
    // that same account, and the agent is not woken for it.
    await shared.admin`UPDATE connections SET status = 'needs_reauth' WHERE id = ${connection.id}`;
    expect(await listed()).toMatchObject({
      connected: false,
      connectionId: connection.id,
      ownership: "personal",
    });
    const expired = await continueAfterSetup(f, session.id, capabilityId);
    expect(await expired.json()).toEqual({ outcome: "not_needed", reason: "not_ready" });
    await shared.admin`UPDATE connections SET status = 'active' WHERE id = ${connection.id}`;
    expect(await listed()).toMatchObject({ connected: true, ownership: "personal" });

    const queued = await continueAfterSetup(f, session.id, capabilityId);
    expect(queued.status, await queued.clone().text()).toBe(200);
    const body = (await queued.json()) as { outcome: string; updateId: string };
    expect(body.outcome).toBe("queued");
    const resumed = await claim(f, session.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      f.workspaceId,
      session.id,
      resumed.turn.id,
    );
    expect(delivered.map((update) => update.summary)).toEqual([
      "The person finished setting up Outlook Mail from your request. Its tools are now available, so continue the request that needed it.",
    ]);
  });
});
