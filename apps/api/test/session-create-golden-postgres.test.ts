// Golden: a session created WITHOUT an organization agent is exactly what it
// was before organization agents existed. The fixture
// (fixtures/session-create-golden.json) was recorded by running this same file
// on the code before organization agents (merge base d07d72764e with main)
// with OPENGENI_GOLDEN_RECORD=1. For representative plain creates through the
// HTTP route (no agent, today's agent object, `agentId`), it compares the
// persisted rows (session, its MCP servers, first turn and events), the
// serialized Session JSON (create response and read) and the built system
// prompt. Columns added later must be NULL on these chats and are the only
// difference allowed.
//
// When a later change intentionally alters the system prompt, the Session JSON
// or the session columns, re-record the fixture on that change with
// OPENGENI_GOLDEN_RECORD=1. The organization-agent columns must stay NULL on
// these chats either way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { Settings } from "@opengeni/config";
import type { Permission } from "@opengeni/contracts";
import { ResolvedAgentConfig, signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createDb, readSessionAgentPrompt, type DbClient } from "@opengeni/db";
import { inspectPersistentAgentInstructions } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

const FIXTURE = new URL("./fixtures/session-create-golden.json", import.meta.url);
const RECORD = process.env.OPENGENI_GOLDEN_RECORD === "1";
/** Session columns added by organization agents (migration 1502): NULL on every other chat. */
const ADDED_SESSION_COLUMNS = ["agent_overrides", "agent_prompt_version", "agent_version"];
/** Values that differ between any two runs (transaction ids, hashes of ids). */
const VOLATILE_KEYS = new Set(["activity_xid", "activity_revision_pending_xid", "controlEtag"]);
const DELEGATION_SECRET = "session-create-golden-secret";
const SUBJECT = "user:golden";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: ReturnType<typeof createApp>;
let settings: Settings;

class WorkflowStub implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-create-golden");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error(
      "[session-create-golden] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    sandboxBackend: "none",
  });
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new WorkflowStub(),
    objectStorage: null,
    githubStateSecret: "golden-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
  app = createApp(deps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(): Promise<Workspace> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Golden') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Golden') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${personal!.id}, ${account!.id})`;
  await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${account!.id}, ${SUBJECT}, 'active', ${personal!.id})`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${account!.id}, ${workspace!.id}, ${SUBJECT})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

const PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "mcp_servers:attach",
];

async function call(workspace: Workspace, method: string, path: string, body?: unknown) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId: SUBJECT,
    subjectLabel: SUBJECT,
    permissions: PERMISSIONS,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as any };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** Run-independent form: known ids named, other ids and times replaced. */
function normalize(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (TIMESTAMP.test(value)) return "<timestamp>";
    let text = value;
    for (const [id, name] of names) text = text.replaceAll(id, name);
    return text.replace(UUID, "<uuid>");
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, names));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [
          key,
          VOLATILE_KEYS.has(key) ? "<volatile>" : normalize(item, names),
        ]),
    );
  }
  return value;
}

type Snapshot = {
  sessionRow: Record<string, unknown>;
  mcpServers: unknown[];
  turns: unknown[];
  events: unknown[];
  created: unknown;
  read: unknown;
  agentPrompt: unknown;
  systemPrompt: string;
};

async function snapshot(
  workspace: Workspace,
  body: Record<string, unknown>,
  names: Map<string, string>,
): Promise<Snapshot> {
  const sessions = `/v1/workspaces/${workspace.workspaceId}/sessions`;
  const created = await call(workspace, "POST", sessions, body);
  expect({ status: created.status, error: created.status === 202 ? null : created.json }).toEqual({
    status: 202,
    error: null,
  });
  const sessionId = created.json.id as string;
  names.set(sessionId, "<session>");
  const read = await call(workspace, "GET", `${sessions}/${sessionId}`);
  expect(read.status).toBe(200);
  const admin = shared!.admin;
  const [row] = await admin<{ row: Record<string, unknown> }[]>`
    select to_jsonb(s) as row from sessions s where id = ${sessionId}`;
  const mcpServers = await admin<{ row: unknown }[]>`
    select to_jsonb(m) as row from session_mcp_servers m where session_id = ${sessionId}
    order by server_id`;
  const turns = await admin<{ row: unknown }[]>`
    select to_jsonb(t) as row from session_turns t where session_id = ${sessionId}
    order by position`;
  const events = await admin<{ row: unknown }[]>`
    select jsonb_build_object('sequence', sequence, 'type', type, 'payload', payload) as row
    from session_events where session_id = ${sessionId} order by sequence`;
  const agentPrompt = await readSessionAgentPrompt(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId,
  });
  const session = read.json as { instructions?: string | null; agent: unknown };
  // The system prompt the worker composes from this chat's settings and its
  // agent prompt layer (the runtime's own composition entry point).
  const systemPrompt = inspectPersistentAgentInstructions(settings, {
    agentConfig: ResolvedAgentConfig.parse(session.agent),
    ...(agentPrompt?.instructions ? { agentInstructions: agentPrompt.instructions } : {}),
    ...(session.instructions ? { sessionInstructions: session.instructions } : {}),
  }).composed;
  return normalize(
    {
      sessionRow: row!.row,
      mcpServers: mcpServers.map((server) => server.row),
      turns: turns.map((turn) => turn.row),
      events: events.map((event) => event.row),
      created: created.json,
      read: read.json,
      agentPrompt,
      systemPrompt,
    },
    names,
  ) as Snapshot;
}

/** The representative plain creates. */
async function plainCreates(): Promise<Record<string, Snapshot>> {
  const result: Record<string, Snapshot> = {};
  {
    const workspace = await freshWorkspace();
    const names = new Map([
      [workspace.accountId, "<account>"],
      [workspace.workspaceId, "<workspace>"],
    ]);
    result["no agent"] = await snapshot(
      workspace,
      {
        initialMessage: "Plan the week",
        model: "scripted-model",
        instructions: "Answer briefly.",
        metadata: { team: "ops" },
        mcpServers: [
          {
            id: "team-notes",
            name: "Team notes",
            url: "https://mcp.example.com/notes",
            allowedTools: ["search"],
            requireApproval: true,
          },
        ],
      },
      names,
    );
  }
  {
    const workspace = await freshWorkspace();
    const names = new Map([
      [workspace.accountId, "<account>"],
      [workspace.workspaceId, "<workspace>"],
    ]);
    result["agent object"] = await snapshot(
      workspace,
      {
        initialMessage: "Plan the week",
        model: "scripted-model",
        reasoningEffort: "high",
        agent: {
          capabilities: { from: "all", subagents: false },
          identity: "You are the operations assistant.",
          renderer: "markdown",
          instructions: "Use bullet points.",
          titleInstructions: "Keep titles short.",
        },
      },
      names,
    );
  }
  {
    const workspace = await freshWorkspace();
    const agent = await call(workspace, "POST", `/v1/workspaces/${workspace.workspaceId}/agents`, {
      name: "Planner",
      instructions: "Plan carefully.",
    });
    expect(agent.status).toBe(201);
    const names = new Map([
      [workspace.accountId, "<account>"],
      [workspace.workspaceId, "<workspace>"],
      [agent.json.agent.id as string, "<agent>"],
    ]);
    result["agentId"] = await snapshot(
      workspace,
      { initialMessage: "Plan the week", model: "scripted-model", agentId: agent.json.agent.id },
      names,
    );
  }
  return result;
}

describe("a create without an organization agent is unchanged", () => {
  test("rows, Session JSON and system prompt equal the recorded pre-organization-agent fixture", async () => {
    if (!shared) return;
    const actual = await plainCreates();
    if (RECORD) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Snapshot>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, recorded] of Object.entries(expected)) {
      const current = actual[name]!;
      // Only the organization-agent columns may be new, and they are NULL here.
      const added = Object.keys(current.sessionRow)
        .filter((column) => !(column in recorded.sessionRow))
        .sort();
      expect({
        name,
        added: added.filter((column) => !ADDED_SESSION_COLUMNS.includes(column)),
      }).toEqual({ name, added: [] });
      for (const column of ADDED_SESSION_COLUMNS)
        expect({ column, value: current.sessionRow[column] }).toEqual({ column, value: null });
      const sessionRow = Object.fromEntries(
        Object.entries(current.sessionRow).filter(
          ([column]) => column in recorded.sessionRow && !ADDED_SESSION_COLUMNS.includes(column),
        ),
      );
      const recordedRow = Object.fromEntries(
        Object.entries(recorded.sessionRow).filter(
          ([column]) => !ADDED_SESSION_COLUMNS.includes(column),
        ),
      );
      expect({ name, ...current, sessionRow }).toEqual({
        name,
        ...recorded,
        sessionRow: recordedRow,
      });
      // Byte for byte.
      expect(current.systemPrompt).toBe(recorded.systemPrompt);
    }
  }, 180_000);
});
