#!/usr/bin/env bun
/**
 * Seed agent-configuration states into a LOCAL managed-mode dev stack, on top
 * of scripts/dev-seed-design-preview.ts (run that first; this reuses its
 * organization, people and credentials file).
 *
 *   bun scripts/dev-fake-mcp-server.ts &            # "Acme Tickets" and friends
 *   bun scripts/dev-seed-agent-config.ts --yes [--credentials <file>] [--no-turns]
 *
 * Needs the stack started with OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true and
 * OPENGENI_AGENT_CONFIG_DEFAULT_FOR_NEW_SESSIONS=true.
 *
 * Creates (idempotent, looked up by name):
 * - "Support desk" (workspace A): 12 connectors pointing at the fake MCP server,
 *   a custom agent identity and instructions, and agent defaults "Only what you
 *   choose" + Goals + Knowledge. Maria is admin, Jonas member, Aiko viewer.
 * - "Research lab" (workspace B): no connectors, no Skills, defaults untouched.
 * - Sessions in A: legacy (no configuration), everything, only own tools,
 *   custom with identity, workspace default, goal-bearing, a child session,
 *   one updated mid-session (session.agent.updated), a Slack-style markdown
 *   renderer session, a private one when the organization allows it; one
 *   "everything" session in B.
 * - A paused schedule in A with its own capabilities.
 *
 * Sessions with a first message run ONE real model turn each (the stack's
 * configured model) so the model-context inspector has captures; pass
 * --no-turns to create empty shells instead. The legacy session and the child
 * are finished via SQL through this worktree's loopback migrations DSN.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
function fail(message: string): never {
  console.error(`dev-seed-agent-config: ${message}`);
  process.exit(1);
}
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return values;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

if (!flag("--yes"))
  fail("refusing to run without --yes (this writes fake data into the local dev stack).");
const runTurns = !flag("--no-turns");
const runtime = readEnvFile(resolve(repositoryRoot, ".env.runtime"));
if (!runtime.OPENGENI_API_PORT)
  fail("no .env.runtime; start this worktree's stack with `bun run dev`.");
const API = `http://127.0.0.1:${runtime.OPENGENI_API_PORT}`;
const migrationsUrl = runtime.OPENGENI_MIGRATIONS_DATABASE_URL;
if (!migrationsUrl || !LOOPBACK.has(new URL(migrationsUrl).hostname)) {
  fail("the worktree migrations database URL is missing or not loopback.");
}
const clientConfig = (await (await fetch(`${API}/v1/config/client`)).json()) as {
  apiContractRevision: string;
  productAccessMode: string;
  agentConfig?: { enabled: boolean; defaultForNewSessions: boolean };
};
if (clientConfig.productAccessMode !== "managed") fail("the API is not in managed mode.");
if (!clientConfig.agentConfig?.enabled) {
  fail("agent settings are off; set OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true and restart.");
}
const CONTRACT = clientConfig.apiContractRevision;
const ORIGIN =
  readEnvFile(resolve(repositoryRoot, ".env")).OPENGENI_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
const credentialsPath =
  option("--credentials") ?? resolve(homedir(), ".config/opengeni-design-preview/credentials");
const credentials = readEnvFile(credentialsPath);
if (!credentials.OWNER_PASSWORD)
  fail(`run scripts/dev-seed-design-preview.ts first (${credentialsPath}).`);
const FAKE_MCP_URL = option("--mcp-url") ?? "http://127.0.0.1:8791/mcp";

class Client {
  cookie: string | null = null;
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { origin: ORIGIN, "x-opengeni-api-contract": CONTRACT };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie?.() ?? []) {
      const pair = value.split(";")[0]!;
      if (pair.startsWith("better-auth.session_token=")) this.cookie = pair;
    }
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!response.ok && !allow.includes(response.status)) {
      throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 600)}`);
    }
    return { status: response.status, body: parsed as T };
  }
  get<T = any>(path: string) {
    return this.request<T>("GET", path).then((r) => r.body);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body).then((r) => r.body);
  }
  put<T = any>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body).then((r) => r.body);
  }
  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body).then((r) => r.body);
  }
}

async function ownerClient(): Promise<Client> {
  const cachePath = resolve(dirname(credentialsPath), "owner-session");
  const client = new Client();
  if (existsSync(cachePath)) {
    client.cookie = readFileSync(cachePath, "utf8").trim();
    const session = await client.request("GET", "/v1/auth/get-session", undefined, [401, 403]);
    if (session.status === 200 && session.body?.user) return client;
  }
  await client.request("POST", "/v1/auth/sign-in/email", {
    email: credentials.OWNER_EMAIL ?? "bendik@acme.dev",
    password: credentials.OWNER_PASSWORD,
  });
  if (!client.cookie) fail("could not sign in as the owner.");
  writeFileSync(cachePath, `${client.cookie}\n`, { mode: 0o600 });
  return client;
}

const log = (message: string) => console.log(message);
const owner = await ownerClient();
const me = await owner.get<any>("/v1/me/access").catch(() => null);
const allWorkspaces = await owner.get<any[]>("/v1/workspaces");
const orgId: string =
  allWorkspaces.find((workspace) => workspace.kind === "shared")?.accountId ??
  me?.accountGrants?.[0]?.accountId ??
  fail("no organization found; run the design-preview seed first.");

async function ensureWorkspace(name: string): Promise<string> {
  const all = await owner.get<any[]>("/v1/workspaces");
  const found = all.find((workspace) => workspace.kind === "shared" && workspace.name === name);
  if (found) return found.id;
  const created = await owner.post<any>(`/v1/organizations/${orgId}/workspaces`, {
    name,
    operationId: randomUUID(),
  });
  log(`Created workspace ${name}`);
  return created.id;
}

async function grant(ws: string, grants: Record<string, "viewer" | "member" | "admin">) {
  const overview = await owner.get<any>(`/v1/organizations/${orgId}/overview`);
  const members: any[] =
    (await owner.get<{ members: any[] }>(`/v1/organizations/${orgId}/members`)).members ?? [];
  const workspaceAccess = (overview.workspaces ?? []).find((workspace: any) => workspace.id === ws);
  for (const [email, role] of Object.entries(grants)) {
    const member = members.find(
      (candidate) => candidate.email?.toLowerCase() === email && candidate.status === "active",
    );
    if (!member) continue;
    const current = (workspaceAccess?.members ?? []).find(
      (candidate: any) => candidate.organizationMembershipId === member.id,
    );
    if (current?.role === role) continue;
    await owner.put(`/v1/organizations/${orgId}/workspaces/${ws}/members/${member.id}`, {
      role,
      expectedUpdatedAt: current?.updatedAt ?? null,
      operationId: randomUUID(),
    });
  }
}

const CONNECTORS = [
  ["acme-tickets", "Acme Tickets", "Search, read and update customer support tickets."],
  ["acme-linear", "Linear", "Issues and projects for the product team."],
  ["acme-notion", "Notion", "The team wiki and meeting notes."],
  ["acme-sentry", "Sentry", "Errors and performance issues from production."],
  ["acme-stripe", "Stripe", "Customers, invoices and refunds."],
  ["acme-hubspot", "HubSpot", "Contacts, companies and deals."],
  ["acme-zendesk", "Zendesk", "The legacy help desk, read only."],
  ["acme-jira", "Jira", "Engineering tickets for escalations."],
  ["acme-confluence", "Confluence", "Runbooks and support playbooks."],
  ["acme-figma", "Figma", "Designs and prototypes."],
  ["acme-datadog", "Datadog", "Dashboards, monitors and logs."],
  ["acme-pagerduty", "PagerDuty", "On-call schedules and incidents."],
] as const;

async function ensureConnectors(ws: string) {
  const catalog = await owner.get<any>(`/v1/workspaces/${ws}/capabilities`);
  const items: any[] = catalog.items ?? [];
  const installed = new Set((catalog.installations ?? []).map((row: any) => row.capabilityId));
  for (const [id, name, description] of CONNECTORS) {
    let item = items.find((candidate) => candidate.name === name && candidate.source === "manual");
    if (!item) {
      item = await owner.post(`/v1/workspaces/${ws}/capabilities`, {
        kind: "mcp",
        source: "manual",
        name,
        description,
        category: "custom",
        endpointUrl: FAKE_MCP_URL,
        metadata: { seed: id },
      });
    }
    if (!installed.has(item.id)) {
      await owner.post(
        `/v1/workspaces/${ws}/capabilities/${encodeURIComponent(item.id)}/enable`,
        {},
      );
    }
  }
  log(`  ${CONNECTORS.length} connectors`);
}

async function ensureInstructions(ws: string, content: string) {
  const policies = await owner.get<any>(`/v1/workspaces/${ws}/instruction-policies`);
  if (
    (policies.revisions ?? []).some((row: any) => row.kind === "policy" && row.scope === "global")
  ) {
    return;
  }
  const draft = await owner.post<any>(`/v1/workspaces/${ws}/instruction-policies/drafts`, {
    operationId: randomUUID(),
    kind: "policy",
    scope: "global",
    roleKey: null,
    content,
    supersedesRevisionId: null,
  });
  await owner.post(`/v1/workspaces/${ws}/instruction-policies/${draft.id}/activate`, {
    operationId: randomUUID(),
    expectedCurrentRevisionId: null,
    reason: "Support desk instructions",
  });
}

type SessionPlan = {
  title: string;
  message?: string;
  agent?: Record<string, unknown>;
  goal?: { text: string; successCriteria?: string };
  visibility?: "private" | "workspace";
};

async function findSession(ws: string, title: string): Promise<any | null> {
  const sessions = await owner.get<any[]>(`/v1/workspaces/${ws}/sessions?limit=200`);
  return sessions.find((session) => session.title === title) ?? null;
}

async function ensureSession(ws: string, plan: SessionPlan): Promise<any | null> {
  const existing = await findSession(ws, plan.title);
  if (existing) return existing;
  const turn = runTurns && plan.message;
  const created = await owner.request<any>(
    "POST",
    `/v1/workspaces/${ws}/sessions`,
    {
      ...(turn ? { initialMessage: plan.message } : { startMode: "realtime" }),
      idempotencyKey: `agent-config-seed:${ws}:${plan.title}`,
      ...(plan.agent ? { agent: plan.agent } : {}),
      ...(plan.goal ? { goal: plan.goal } : {}),
      ...(plan.visibility ? { visibility: plan.visibility } : {}),
    },
    [403, 409, 422],
  );
  if (created.status >= 400) {
    log(
      `  skipped "${plan.title}": ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`,
    );
    return null;
  }
  const session = created.body;
  await owner.request(
    "PATCH",
    `/v1/workspaces/${ws}/sessions/${session.id}`,
    { title: plan.title },
    [400, 404, 405, 409, 422],
  );
  log(`  session "${plan.title}"${turn ? " (one turn)" : ""}`);
  return session;
}

async function waitIdle(ws: string, sessionId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await owner.get<any>(`/v1/workspaces/${ws}/sessions/${sessionId}`);
    if (
      ["idle", "failed", "cancelled", "completed"].includes(session.status) &&
      !session.activeTurnId
    ) {
      return session;
    }
    await Bun.sleep(2_000);
  }
  log(`  (still running after ${timeoutMs / 1000}s: ${sessionId})`);
  return await owner.get<any>(`/v1/workspaces/${ws}/sessions/${sessionId}`);
}

// ---------------------------------------------------------------------------
// Workspace A: Support desk
// ---------------------------------------------------------------------------
const A = await ensureWorkspace("Support desk");
log("Support desk");
await grant(A, {
  "maria@acme.dev": "admin",
  "jonas@acme.dev": "member",
  "aiko@acme.dev": "viewer",
});
await ensureConnectors(A);
await ensureInstructions(
  A,
  [
    "# Support desk rules",
    "- Answer customers in plain, friendly language.",
    "- Never promise a refund; open a ticket for the billing team instead.",
    "- Link the ticket you used when you answer.",
  ].join("\n"),
);
await owner.patch(`/v1/workspaces/${A}/settings`, {
  sessionAgentDefaults: {
    capabilities: { from: "none", goals: true, knowledge: true },
    identity:
      "You are Acme's support desk agent. You help the support team answer customers, find the right ticket and write short, friendly replies.",
  },
});

const sessionsA: SessionPlan[] = [
  {
    title: "Everything the workspace offers",
    message: "In one sentence, what can you help me with today?",
    agent: { capabilities: "all" },
  },
  {
    title: "Only its own tools",
    message: "Reply with the word ready.",
    agent: { capabilities: "none" },
  },
  {
    title: "Ticket triage assistant",
    message: "Say hello to the support team in one short sentence.",
    agent: {
      capabilities: { from: "none", webSearch: true, knowledge: true, workspaceConnectors: true },
      identity:
        "You are Acme's ticket triage assistant. You sort new tickets and suggest who should own them.",
    },
  },
  {
    title: "Workspace defaults",
    message: "Reply with one short sentence about what you are.",
  },
  {
    title: "Release notes goal",
    message: "Write a two-line summary of what a release note is, then finish.",
    agent: { capabilities: { from: "none", goals: true } },
    goal: {
      text: "Write a two-line summary of what a release note is.",
      successCriteria: "Two lines, plain language.",
    },
  },
  {
    title: "Changed mid-session",
    message: "Reply with the word noted.",
    agent: { capabilities: "all" },
  },
  {
    title: "Slack: weekly ticket volume",
    message: "In one sentence, how would you report weekly ticket volume?",
    agent: { capabilities: { from: "none", knowledge: true }, renderer: "markdown" },
  },
  {
    title: "Private notes",
    message: "Reply with the word private.",
    agent: { capabilities: { from: "none", knowledge: true } },
    visibility: "private",
  },
  { title: "Legacy session", message: "Reply with the word legacy." },
];
const createdA: Record<string, any> = {};
for (const plan of sessionsA) {
  const session = await ensureSession(A, plan);
  if (session) createdA[plan.title] = session;
}
if (runTurns) {
  for (const session of Object.values(createdA)) await waitIdle(A, session.id);
}

// Changed mid-session: narrow it once, which records session.agent.updated.
{
  const session = await owner
    .get<any>(`/v1/workspaces/${A}/sessions/${createdA["Changed mid-session"]?.id}`)
    .catch(() => null);
  if (session && session.agent?.capabilities?.browser !== false) {
    await owner.put(`/v1/workspaces/${A}/sessions/${session.id}/agent`, {
      agent: { capabilities: { from: "all", browser: false, media: false, workspaceAdmin: false } },
      expectedVersion: session.toolPolicyVersion,
    });
    log('  narrowed "Changed mid-session"');
  }
}

// Paused schedule with its own capabilities.
{
  const tasks = await owner.get<any[]>(`/v1/workspaces/${A}/scheduled-tasks`);
  if (!tasks.some((task) => task.name === "Morning ticket digest")) {
    await owner.post(`/v1/workspaces/${A}/scheduled-tasks`, {
      name: "Morning ticket digest",
      status: "paused",
      schedule: {
        type: "calendar",
        hour: 8,
        minute: 0,
        timeZone: "Europe/Oslo",
        daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      },
      runMode: "new_session_per_run",
      agentConfig: {
        prompt: "Summarize yesterday's new tickets and flag anything urgent.",
        agent: { capabilities: { from: "none", knowledge: true, workspaceConnectors: true } },
      },
    });
    log('  schedule "Morning ticket digest"');
  }
}

// ---------------------------------------------------------------------------
// SQL-only states: a legacy session and a child session.
// ---------------------------------------------------------------------------
const sql = new SQL(migrationsUrl);
async function withSessionGate(ws: string, work: (tx: any) => Promise<void>) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${"workspace-control:" + ws}, 0))`;
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${"session-tenancy:" + ws}, 0))`;
    await tx`select set_config('opengeni.session_activity_gate_state', 'open', true),
                    set_config('opengeni.session_activity_gate_workspace_id', ${ws}, true)`;
    await work(tx);
    await tx`select set_config('opengeni.session_activity_gate_state', 'preparing', true)`;
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.unsafe(
      "SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard DEFERRED",
    );
    await tx`select set_config('opengeni.session_activity_gate_state', 'finalizing', true)`;
    await tx`with advanced as (
        update workspace_session_activity_revisions set revision = revision + 1
        where workspace_id = ${ws} returning revision)
      update sessions s set activity_revision = advanced.revision, activity_revision_pending_xid = null
      from advanced
      where s.workspace_id = ${ws} and s.activity_revision_pending_xid = pg_current_xact_id()::text::bigint`;
    await tx`select set_config('opengeni.session_activity_gate_state', 'finalized', true)`;
    await tx.unsafe(
      "SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard IMMEDIATE",
    );
  });
}

const legacy = createdA["Legacy session"];
if (legacy) {
  await withSessionGate(A, async (tx) => {
    await tx`update sessions set agent_config = null where workspace_id = ${A} and id = ${legacy.id}`;
  });
  log('  "Legacy session" has no agent configuration');
}

const parent = createdA["Everything the workspace offers"];
if (parent) {
  const childTitle = "Research customer sentiment";
  const [existing] =
    await sql`select id from sessions where workspace_id = ${A} and parent_session_id = ${parent.id} and title = ${childTitle}`;
  if (!existing) {
    const childId = randomUUID();
    const childConfig = {
      version: 1,
      from: "none",
      capabilities: {
        webSearch: true,
        humanInput: true,
        skills: "read",
        goals: false,
        subagents: false,
        knowledge: true,
        schedules: false,
        artifacts: false,
        browser: false,
        media: false,
        workspaceFiles: false,
        workspaceConnectors: false,
        workspaceAdmin: false,
      },
      unavailable: [],
      identity: null,
      renderer: "opengeni",
      source: "inherited",
    };
    await withSessionGate(A, async (tx) => {
      await tx`insert into sessions (id, status, initial_message, resources, tools, metadata, model,
          sandbox_backend, temporal_workflow_id, account_id, workspace_id, parent_session_id, sandbox_os,
          sandbox_group_id, title, title_source, tool_policy, created_by_kind, created_by_subject_id,
          created_by_context, root_session_id, nested_agent_depth, effective_max_nested_agent_depth,
          nested_agent_depth_policy_source, skills, first_party_mcp_tools, codex_compaction_mode,
          reasoning_effort, latency_mode, visibility, create_requested_visibility, variable_set_ids,
          agent_access, memory_scope, mcp_approval_policies, initial_xai_provider_account_authority_snapshot,
          agent_config)
        select ${childId}, 'idle', '', p.resources, '[{"id":"opengeni","kind":"mcp"}]'::jsonb, '{}'::jsonb, p.model, p.sandbox_backend,
          ${"session-" + childId}, p.account_id, p.workspace_id, p.id, p.sandbox_os, gen_random_uuid(),
          ${childTitle}, 'user', jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', p.id::text),
          p.created_by_kind, p.created_by_subject_id, p.created_by_context, p.root_session_id,
          p.nested_agent_depth + 1, p.effective_max_nested_agent_depth, p.nested_agent_depth_policy_source,
          p.skills, '["set_session_title","wait_for_input","command_read","command_wait"]'::jsonb,
          p.codex_compaction_mode, p.reasoning_effort, p.latency_mode,
          p.visibility, p.create_requested_visibility, '[]'::jsonb, p.agent_access, p.memory_scope,
          p.mcp_approval_policies, p.initial_xai_provider_account_authority_snapshot,
          ${childConfig}::jsonb
        from sessions p where p.workspace_id = ${A} and p.id = ${parent.id}`;
      const [created] = await tx`select payload from session_events
        where workspace_id = ${A} and session_id = ${parent.id} and sequence = 1`;
      await tx`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload,
          payload_codec_version, occurred_at, created_at)
        values (${parent.accountId}, ${A}, ${childId}, 1, 'session.created', ${created.payload}, 1, now(), now())`;
    });
    log(`  child session "${childTitle}"`);
  }
}
await sql.close();

// ---------------------------------------------------------------------------
// Workspace B: Research lab (no connectors, no Skills, defaults untouched)
// ---------------------------------------------------------------------------
const B = await ensureWorkspace("Research lab");
log("Research lab");
await grant(B, { "maria@acme.dev": "member", "jonas@acme.dev": "viewer" });
const labSession = await ensureSession(B, {
  title: "Compare vector databases",
  message: "In one sentence, what is a vector database?",
});
if (runTurns && labSession) await waitIdle(B, labSession.id);

log("\nDone.");
log(`  Support desk: ${ORIGIN}/workspaces/${A}/sessions`);
log(`  Research lab: ${ORIGIN}/workspaces/${B}/sessions`);
