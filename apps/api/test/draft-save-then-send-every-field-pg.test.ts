import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  NewSessionDraftOptions,
  SaveComposerDraftRequest,
  SaveNewSessionDraftRequest,
  signDelegatedAccessToken,
  type AccessGrant,
} from "@opengeni/contracts";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  bootstrapWorkspace,
  claimEnrollmentConnection,
  createDb,
  createEnrollment,
  createRig,
  createSandbox,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// Every field a composer can save in a draft must survive "save, then Send".
// Send carries its own content and is never refused over the draft. After it
// is accepted, the draft is cleared when it is still at the revision the Send
// was composed from, or when it holds exactly what was sent. Each Send below
// names the revision before its own save, so only the content comparison can
// clear the draft: a field compared differently on the two sides would leave a
// sent message behind as the draft. The cases are keyed by the contract
// schemas, so a field added to a draft without a case here fails this file.

const SECRET = "draft-save-then-send-every-field-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("draft-save-then-send");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Draft save-then-Send tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings({
  delegationSecret: SECRET,
  sandboxBackend: "none",
  sandboxSelfhostedEnabled: true,
  selfhostedRelayUrl: "wss://relay.example",
  mcpServers: [{ id: "docs", url: "https://docs.example/mcp", cacheToolsList: false }],
});

type Json = Record<string, unknown>;

async function fixture() {
  if (!client || !shared) throw new Error("PostgreSQL fixture unavailable");
  const admin = shared.admin;
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test:draft-save-then-send",
    accountExternalId: crypto.randomUUID(),
    accountName: "Draft save then Send",
    workspaceExternalSource: "test:draft-save-then-send",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Draft save then Send",
    subjectId: `user:draft-save-then-send-${crypto.randomUUID()}`,
  });
  const grant = context.workspaceGrants[0]! as AccessGrant;
  const bus = new MemoryEventBus();
  const app = createApp({
    settings,
    db: client.db,
    bus,
    workflowClient: {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    // Only the presence of storage is checked for a ready file; nothing is read.
    objectStorage: {} as never,
    managedAuth: null,
  });
  async function request(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    return app.request(`/v1/workspaces/${grant.workspaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          ...grant,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        })}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function readyFile(): Promise<string> {
    const id = crypto.randomUUID();
    await admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`insert into files (id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, sha256, bucket, object_key)
        values (${id}::uuid, ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'ready',
          'notes.txt', 'notes.txt', 'text/plain', 4, ${"a".repeat(64)}, 'fixture',
          ${`fixture/${id}`})`;
    });
    return id;
  }
  /** An enrolled machine whose agent is connected and answers the liveness ping. */
  async function machine(): Promise<string> {
    const enrollment = await createEnrollment(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: false,
      allowScreenControl: false,
      os: "linux",
      arch: "x86_64",
    });
    const connectionInstanceId = crypto.randomUUID();
    const connection = await claimEnrollmentConnection(client!.db, {
      workspaceId: grant.workspaceId,
      enrollmentId: enrollment.id,
      credentialGeneration: enrollment.credentialGeneration,
      connectionInstanceId,
      leaseMs: 600_000,
    });
    expect(connection.claimed).toBe(true);
    await admin`
      update enrollments set last_seen_at = now(), workspace_root = '/srv/project'
      where id = ${enrollment.id}`;
    const sandbox = await createSandbox(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      kind: "selfhosted",
      name: "draft fixture machine",
      enrollmentId: enrollment.id,
    });
    bus.subscribeRequests(
      subjectFor(grant.workspaceId, enrollment.id, connectionInstanceId),
      async (payload) => {
        const control = ControlRequest.decode(payload);
        const response: ControlResponse =
          control.op?.$case === "ping"
            ? {
                requestId: control.requestId,
                result: {
                  $case: "ping",
                  ping: {
                    nonce: control.op.ping.nonce,
                    agentMonotonicMs: "0",
                    controlReplayTokens: [],
                  },
                },
              }
            : {
                requestId: control.requestId,
                error: {
                  code: ErrorCode.ERROR_CODE_UNSUPPORTED,
                  message: "unsupported",
                  retryable: false,
                  detail: {},
                },
              };
        return ControlResponse.encode(response).finish();
      },
    );
    return sandbox.id;
  }
  async function rig(): Promise<string> {
    const created = await createRig(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Draft fixture environment",
    });
    return created.id;
  }
  async function channel(): Promise<string> {
    const response = await request("POST", "/channels", { name: "Draft fixture project" });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return ((await response.json()) as { id: string }).id;
  }
  return { grant, admin, request, readyFile, machine, rig, channel };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What the composer saves in the draft, and what its Send carries for it. */
type FieldCase = (f: Fixture) => Promise<{ draft: Json; create: Json }>;

type NewChatTopField = Exclude<keyof SaveNewSessionDraftRequest, "expectedRevision" | "options">;
type NewChatOptionField = `options.${keyof NewSessionDraftOptions}`;

const option = (draft: Json, create: Json = draft) => ({ draft: { options: draft }, create });

const NEW_CHAT_FIELDS: Record<NewChatTopField | NewChatOptionField, FieldCase> = {
  text: async () => ({
    draft: { text: "Summarise the notes" },
    create: { initialMessage: "Summarise the notes" },
  }),
  resources: async (f) => {
    const resources = [{ kind: "file", fileId: await f.readyFile() }];
    return { draft: { resources }, create: { resources } };
  },
  tools: async () => {
    const tools = [{ kind: "mcp", id: "docs" }];
    return { draft: { tools, toolsProvided: true }, create: { tools } };
  },
  toolsProvided: async () => ({ draft: { tools: [], toolsProvided: true }, create: { tools: [] } }),
  model: async () => ({ draft: { model: "gpt-5.6-terra" }, create: { model: "gpt-5.6-terra" } }),
  reasoningEffort: async () => ({
    draft: { reasoningEffort: "low" },
    create: { reasoningEffort: "low" },
  }),
  latencyMode: async () => {
    const policy = { model: "gpt-5.6-sol", latencyMode: "fast" };
    return { draft: policy, create: policy };
  },
  modelProvided: async () => ({ draft: { modelProvided: false }, create: {} }),
  selectedProjectChannelId: async (f) => {
    const channelId = await f.channel();
    return { draft: { selectedProjectChannelId: channelId }, create: { channelId } };
  },
  "options.agentLearning": async () =>
    option({ agentLearning: { knowledge: "off", skills: "review_first" } }),
  "options.excludedMcpServerIds": async () => ({
    // Customize on, following workspace connectors minus one: the draft keeps
    // an explicit empty list, the Send omits tools (see #3683).
    draft: { tools: [], toolsProvided: true, options: { excludedMcpServerIds: ["docs"] } },
    create: { excludedMcpServerIds: ["docs"] },
  }),
  "options.visibility": async () => option({ visibility: "workspace" }),
  "options.sandboxBackend": async () => option({ sandboxBackend: "none" }),
  "options.targetSandboxId": async (f) => option({ targetSandboxId: await f.machine() }),
  "options.workingDir": async (f) =>
    option({ targetSandboxId: await f.machine(), workingDir: "projects/app" }),
  "options.rigId": async (f) => option({ rigId: await f.rig() }),
  "options.goal": async () => option({ goal: { text: "Ship the release notes" } }),
  "options.firstPartyMcpPermissions": async () =>
    option({ firstPartyMcpPermissions: ["sessions:read"] }),
  "options.firstPartyMcpTools": async () => option({ firstPartyMcpTools: ["knowledge_search"] }),
  "options.agent": async () => option({ agent: { instructions: "Answer in one paragraph." } }),
};

type ExistingChatField = Exclude<keyof SaveComposerDraftRequest, "expectedRevision">;

const EXISTING_CHAT_FIELDS: Record<ExistingChatField, FieldCase> = {
  text: async () => ({
    draft: { text: "And the next step?" },
    create: { text: "And the next step?" },
  }),
  annotations: async () => {
    // Filled in by the test from the chat's real first message.
    return { draft: {}, create: {} };
  },
  resources: async (f) => {
    const resources = [{ kind: "file", fileId: await f.readyFile() }];
    return { draft: { resources }, create: { resources } };
  },
  model: async () => {
    const policy = { model: "gpt-5.6-terra", reasoningEffort: "high", latencyMode: "standard" };
    return { draft: policy, create: policy };
  },
  reasoningEffort: async () => {
    const policy = { model: "scripted-model", reasoningEffort: "low", latencyMode: "standard" };
    return { draft: policy, create: policy };
  },
  latencyMode: async () => {
    const policy = { model: "gpt-5.6-sol", reasoningEffort: "high", latencyMode: "fast" };
    return { draft: policy, create: policy };
  },
};

function objectKeys(schema: { shape: Record<string, unknown> }, without: string[]): string[] {
  return Object.keys(schema.shape)
    .filter((key) => !without.includes(key))
    .sort();
}

describe("every draft field survives save, then Send", () => {
  test("the cases cover every field of both draft contracts", () => {
    expect(Object.keys(NEW_CHAT_FIELDS).sort()).toEqual(
      [
        ...objectKeys(SaveNewSessionDraftRequest, ["expectedRevision", "options"]),
        ...objectKeys(NewSessionDraftOptions, []).map((key) => `options.${key}`),
      ].sort(),
    );
    expect(Object.keys(EXISTING_CHAT_FIELDS).sort()).toEqual(
      objectKeys(SaveComposerDraftRequest, ["expectedRevision"]),
    );
  });

  for (const [field, sample] of Object.entries(NEW_CHAT_FIELDS)) {
    test(`new chat: ${field}`, async () => {
      if (!client) return;
      const f = await fixture();
      const { draft, create } = await sample(f);
      const loaded = await f.request("GET", "/new-session-draft");
      expect(loaded.status).toBe(200);
      const base = {
        text: "Start here",
        resources: [],
        tools: [],
        toolsProvided: false,
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        latencyMode: "standard",
        modelProvided: true,
        options: {},
      };
      const saveBody = {
        ...base,
        ...draft,
        options: { ...base.options, ...(draft.options as Json | undefined) },
        expectedRevision: ((await loaded.json()) as { revision: number }).revision,
      };
      const saved = await f.request("PUT", "/new-session-draft", saveBody);
      expect(saved.status, await saved.clone().text()).toBe(200);
      const revision = ((await saved.json()) as { revision: number }).revision;
      // Composed before the save landed: only the content says it was sent.
      const basis = saveBody.expectedRevision;

      const created = await f.request("POST", "/sessions", {
        initialMessage: base.text,
        resources: base.resources,
        model: base.model,
        reasoningEffort: base.reasoningEffort,
        latencyMode: base.latencyMode,
        ...create,
        clientEventId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        expectedNewSessionDraftRevision: basis,
      });
      expect(created.status, await created.clone().text()).toBe(202);

      const after = (await (await f.request("GET", "/new-session-draft")).json()) as {
        revision: number;
        text: string;
      };
      expect(after.text).toBe("");
      expect(after.revision).toBe(revision + 1);
    }, 180_000);
  }

  test("new chat: an Agent learning override with nothing overridden is not a draft change", async () => {
    if (!client) return;
    const f = await fixture();
    const saved = await f.request("PUT", "/new-session-draft", {
      text: "Start here",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: settings.openaiModel,
      reasoningEffort: settings.openaiReasoningEffort,
      latencyMode: "standard",
      modelProvided: true,
      options: { agentLearning: {} },
      expectedRevision: 0,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const created = await f.request("POST", "/sessions", {
      initialMessage: "Start here",
      resources: [],
      model: settings.openaiModel,
      reasoningEffort: settings.openaiReasoningEffort,
      latencyMode: "standard",
      clientEventId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      expectedNewSessionDraftRevision: ((await saved.json()) as { revision: number }).revision,
    });
    expect(created.status, await created.clone().text()).toBe(202);
  }, 180_000);

  for (const [field, sample] of Object.entries(EXISTING_CHAT_FIELDS)) {
    test(`existing chat follow-up: ${field}`, async () => {
      if (!client) return;
      const f = await fixture();
      const firstMessage = "Read the release notes";
      const created = await f.request("POST", "/sessions", {
        initialMessage: firstMessage,
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        clientEventId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(created.status, await created.clone().text()).toBe(202);
      const session = (await created.json()) as { id: string };
      const { draft, create } = await sample(f);
      if (field === "annotations") {
        const annotations = [await annotationOn(f, session.id, firstMessage)];
        Object.assign(draft, { annotations });
        Object.assign(create, { annotations });
      }
      const draftPath = `/sessions/${session.id}/composer-draft`;
      const loaded = await f.request("GET", draftPath);
      expect(loaded.status, await loaded.clone().text()).toBe(200);
      const base = { text: "Follow up", annotations: [], resources: [] };
      const first = await f.request("PUT", draftPath, {
        ...base,
        expectedRevision: ((await loaded.json()) as { revision: number }).revision,
      });
      expect(first.status, await first.clone().text()).toBe(200);
      // Composed before the field was saved: only the content says it was sent.
      const basis = ((await first.json()) as { revision: number }).revision;
      const saved = await f.request("PUT", draftPath, {
        ...base,
        ...draft,
        expectedRevision: basis,
      });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const revision = ((await saved.json()) as { revision: number }).revision;

      const submitted = await f.request("POST", `${draftPath}/submit`, {
        ...base,
        ...create,
        expectedDraftRevision: basis,
        clientEventId: crypto.randomUUID(),
        delivery: "send",
      });
      expect(submitted.status, await submitted.clone().text()).toBeLessThan(300);
      const after = (await (await f.request("GET", draftPath)).json()) as {
        revision: number;
        text: string;
      };
      expect(after.text).toBe("");
      expect(after.revision).toBe(revision + 1);
    }, 180_000);
  }
});

/** An annotation quoting the chat's first message, as the timeline makes one. */
async function annotationOn(f: Fixture, sessionId: string, text: string) {
  const [message] = await f.admin<{ id: string; sequence: number; turnId: string | null }[]>`
    select id, sequence, turn_id as "turnId" from session_events
    where session_id = ${sessionId} and type = 'user.message'
    order by sequence limit 1`;
  if (!message) throw new Error("the chat has no first message to annotate");
  const quote = "release notes";
  const startOffset = text.indexOf(quote);
  return {
    id: crypto.randomUUID(),
    source: {
      kind: "user_message",
      eventId: message.id,
      eventType: "user.message",
      sequence: Number(message.sequence),
      turnId: message.turnId ?? null,
      startOffset,
      endOffset: startOffset + quote.length,
      contextBefore: text.slice(0, startOffset),
      contextAfter: text.slice(startOffset + quote.length),
      label: "You",
    },
    quote,
    note: "Start with these",
  };
}
