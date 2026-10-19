import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allAgentCapabilities, type FirstPartyMcpToolName } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  type DbClient,
} from "../src/index";

// A fork is the same agent as its source. Every sessions column is classified
// below: either the fork copies it from the source exactly, or it belongs to
// the new session (identity, ownership, provenance, lifecycle, the person who
// forks). A column added later must be placed on one side, or this fails.

type Row = Record<string, unknown>;
type Context = { source: Row; fork: Row; actor: string; actorMembershipId: string };

/** Agent settings: the fork must equal its source exactly. */
const COPIED = [
  "account_id",
  "workspace_id",
  "initial_message",
  "initial_message_codec_version",
  "initial_model_context",
  "title",
  "title_source",
  "instructions",
  "policy_role",
  "skills",
  "tools",
  "tool_policy",
  "first_party_mcp_tools",
  "first_party_mcp_permissions",
  "mcp_approval_policies",
  "agent_config",
  "agent_access",
  "memory_scope",
  "vault_policy",
  "code_search_enabled",
  "model",
  "reasoning_effort",
  "latency_mode",
  "codex_compaction_mode",
  "sandbox_backend",
  "sandbox_os",
  "channel_id",
  "keep_live",
  "rig_id",
  "rig_version_id",
  "initial_xai_provider_account_authority_snapshot",
  "initial_claude_provider_account_authority_snapshot",
  "max_nested_agent_depth_override",
  "effective_max_nested_agent_depth",
  "nested_agent_depth_policy_source",
  // The source's creator holds no manual pin here; a manual pin carries over
  // only to that same person's fork, a policy pin never does.
  "codex_pinned_credential_id",
  "codex_pin_source",
] as const;

const fresh = (value: unknown) => () => value;
const equalsForkId = ({ fork }: Context) => fork.id;

/** Columns that belong to the new session, each with why and its exact value. */
const OWN: Record<string, { why: string; expected: (context: Context) => unknown }> = {
  id: { why: "new identity", expected: ({ fork, source }) => notEqual(fork.id, source.id) },
  created_at: { why: "new row", expected: ({ fork }) => fork.created_at },
  updated_at: { why: "new row", expected: ({ fork }) => fork.updated_at },
  authority_inserted_at: { why: "new row", expected: ({ fork }) => fork.authority_inserted_at },
  created_by_kind: { why: "the forking person creates it", expected: fresh("subject") },
  created_by_subject_id: { why: "the forking person", expected: ({ actor }) => actor },
  created_by_context: {
    why: "fork provenance",
    expected: ({ fork, source }) => ({
      ...(fork.created_by_context as Row),
      fork: true,
      sourceSessionId: source.id,
    }),
  },
  owner_organization_membership_id: {
    why: "the forking person owns it",
    expected: ({ actorMembershipId }) => actorMembershipId,
  },
  owner_subject_id: { why: "the forking person owns it", expected: ({ actor }) => actor },
  scope_subject_id: { why: "binds to the person creating it", expected: ({ actor }) => actor },
  visibility: { why: "requested by the forking person", expected: fresh("user_private") },
  create_requested_visibility: {
    why: "records what the fork's creator asked for; the source's request is its own history",
    expected: fresh("user_private"),
  },
  authority_epoch: { why: "new authority", expected: fresh(1) },
  execution_authority_epoch: { why: "new authority", expected: fresh(1) },
  forked_from_session_id: { why: "provenance", expected: ({ source }) => source.id },
  forked_from_authority_epoch: {
    why: "provenance",
    expected: ({ source }) => source.authority_epoch,
  },
  forked_from_visibility: { why: "provenance", expected: ({ source }) => source.visibility },
  forked_at: { why: "provenance", expected: ({ fork }) => notNull(fork.forked_at) },
  forked_by_organization_membership_id: {
    why: "provenance",
    expected: ({ actorMembershipId }) => actorMembershipId,
  },
  metadata: {
    why: "keeps the agent settings, drops the source's schedule run link",
    expected: ({ source }) => {
      const { scheduledTaskId: _task, scheduledTaskRunId: _run, ...rest } = source.metadata as Row;
      return rest;
    },
  },
  resources: {
    why: "the source creator's credential bindings are stripped",
    expected: ({ source }) => source.resources,
  },
  create_idempotency_key: { why: "the source's create request", expected: fresh(null) },
  agent_creation_attempt_id: { why: "the source's create request", expected: fresh(null) },
  imported_archive_import_id: { why: "the source's import", expected: fresh(null) },
  imported_archive_imported_at: { why: "the source's import", expected: fresh(null) },
  imported_archive_request_hash: { why: "the source's import", expected: fresh(null) },
  imported_archive_subject_id: { why: "the source's import", expected: fresh(null) },
  imported_archive_next_offset: { why: "the source's import", expected: fresh(null) },
  end_user_source: { why: "historical label", expected: fresh(null) },
  end_user_id: { why: "historical label", expected: fresh(null) },
  site_id: { why: "derived for a Site conversation itself", expected: fresh(null) },
  site_access_root_id: { why: "derived for a Site conversation", expected: fresh(null) },
  site_viewer_principal: { why: "derived for a Site conversation", expected: fresh(null) },
  site_owner_subject_id: { why: "derived for a Site conversation", expected: fresh(null) },
  parent_session_id: { why: "a fork is a root", expected: fresh(null) },
  parent_turn_id: { why: "a fork is a root", expected: fresh(null) },
  root_session_id: { why: "a fork is a root", expected: equalsForkId },
  nested_agent_depth: { why: "a fork is a root", expected: fresh(0) },
  nested_agent_depth_policy_session_id: {
    why: "the copied limit is now the fork's own",
    expected: equalsForkId,
  },
  status: { why: "nothing runs yet", expected: fresh("idle") },
  temporal_workflow_id: { why: "nothing runs yet", expected: fresh(null) },
  active_turn_id: { why: "nothing runs yet", expected: fresh(null) },
  execution_context_turn_id: { why: "nothing runs yet", expected: fresh(null) },
  last_sequence: {
    why: "its own history",
    expected: ({ fork }) => notEqual(fork.last_sequence, null),
  },
  queue_version: { why: "its own queue", expected: fresh(0) },
  queue_head_position: { why: "its own queue", expected: fresh(0) },
  queue_tail_position: { why: "its own queue", expected: fresh(0) },
  sandbox_group_id: { why: "its own sandbox group", expected: equalsForkId },
  active_sandbox_id: { why: "its own sandbox", expected: fresh(null) },
  active_epoch: { why: "its own sandbox", expected: fresh(0) },
  working_dir: { why: "its own sandbox", expected: fresh(null) },
  codex_last_credential_id: { why: "its own measurements", expected: fresh(null) },
  last_input_tokens: { why: "its own measurements", expected: fresh(null) },
  compact_requested: { why: "its own measurements", expected: fresh(false) },
  direct_control_state: { why: "its own controls", expected: fresh("active") },
  direct_pause_revision: { why: "its own controls", expected: fresh(null) },
  subtree_run_override_revision: { why: "its own controls", expected: fresh(null) },
  control_version: { why: "its own controls", expected: fresh(0) },
  direct_control_reason: { why: "its own controls", expected: fresh(null) },
  direct_control_changed_by: { why: "its own controls", expected: fresh(null) },
  direct_control_changed_at: { why: "its own controls", expected: fresh(null) },
  activity_revision: { why: "its own activity", expected: ({ fork }) => fork.activity_revision },
  activity_revision_pending_xid: {
    why: "its own activity",
    expected: ({ fork }) => fork.activity_revision_pending_xid,
  },
  activity_xid: { why: "its own activity", expected: ({ fork }) => fork.activity_xid },
  input_wait_turn_id: { why: "its own waits", expected: fresh(null) },
  input_wait_until: { why: "its own waits", expected: fresh(null) },
  input_wait_reason: { why: "its own waits", expected: fresh(null) },
  input_wait_set_at: { why: "its own waits", expected: fresh(null) },
  admission_block: { why: "its own admission", expected: fresh(null) },
  content_archive_state: { why: "its own archive", expected: fresh(null) },
  content_archive_started_at: { why: "its own archive", expected: fresh(null) },
  content_archived_at: { why: "its own archive", expected: fresh(null) },
  content_archive: { why: "its own archive", expected: fresh(null) },
  content_archive_purged_at: { why: "its own archive", expected: fresh(null) },
  tool_policy_version: { why: "edit counter of this row's policy", expected: fresh(1) },
  variable_set_ids: { why: "retired; only explicit fork runtime", expected: fresh([]) },
  variable_set_id: { why: "retired; only explicit fork runtime", expected: fresh(null) },
  initial_personal_connection_delegations: {
    why: "accepted for the source's first turn only",
    expected: fresh([]),
  },
  initial_mcp_account_bindings: {
    why: "accepted for the source's first turn only",
    expected: fresh([]),
  },
  initial_connection_account_intent: {
    why: "accepted for the source's first turn only",
    expected: fresh(null),
  },
  initial_personal_resource_attachment_intent: {
    why: "accepted for the source's first turn only",
    expected: fresh(null),
  },
};

function notEqual(value: unknown, other: unknown) {
  expect(value).not.toEqual(other);
  return value;
}

function notNull(value: unknown) {
  expect(value).not.toBeNull();
  return value;
}

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-fork-agent-parity");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization() {
  const ownerUserId = `fork-parity-owner-${crypto.randomUUID()}`;
  const memberUserId = `fork-parity-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Fork parity owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Fork parity member",
  });
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'fork-parity-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  return { accountId, workspaceId, owner, member };
}

type Org = Awaited<ReturnType<typeof organization>>;

const firstPartyTools: FirstPartyMcpToolName[] = [
  "sessions_list",
  "session_send_message",
  "session_events",
  "knowledge_search",
];

/** A source configured the way a real chat is: every agent setting non-default. */
async function configuredSource(org: Org) {
  const session = await createSession(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    visibility: "workspace_shared",
    initialMessage: "Plan the release",
    initialModelContext: "Context the creator attached",
    resources: [],
    tools: Array.from({ length: 3 }, (_, index) => ({
      kind: "mcp" as const,
      id: `connector-${index}`,
      optional: true,
    })),
    toolPolicy: {
      mode: "workspace_default",
      firstPartyMode: "workspace_default",
      inheritedFromSessionId: null,
    },
    firstPartyMcpTools: firstPartyTools,
    firstPartyMcpPermissions: ["sessions:read", "sessions:create"],
    mcpApprovalPolicies: { "connector-0": true },
    agentConfig: {
      version: 1,
      from: "all",
      capabilities: allAgentCapabilities(),
      unavailable: [],
      identity: null,
      renderer: "opengeni",
      source: "deployment_default",
    },
    agentAccess: "user",
    memoryScope: "user",
    vaultPolicy: { mode: "selected", vaultIds: [] },
    instructions: "Answer in short sentences.",
    policyRole: "planner",
    metadata: {
      model: "test-model",
      latencyMode: "standard",
      reasoningEffort: "high",
      turnExecutionPolicyV1: { version: 1, mode: "standard" },
      scheduledTaskId: crypto.randomUUID(),
      scheduledTaskRunId: crypto.randomUUID(),
    },
    createdBy: { kind: "subject", subjectId: org.owner },
    subjectId: org.owner,
    model: "test-model",
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
    codeSearchDeploymentPolicy: { available: true, workspaceDefault: "on" },
    maxNestedAgentDepthOverride: 2,
    initialXaiProviderAccountAuthoritySnapshot: { version: 1, scope: "organization" },
    initialClaudeProviderAccountAuthoritySnapshot: { version: 1, scope: "organization" },
    mcpServers: [
      {
        id: "creator-credentialed",
        name: "Creator credentialed",
        url: "https://mcp.example.test/credentialed",
        allowedTools: ["search"],
        timeoutMs: 30_000,
        cacheToolsList: true,
        headersEncrypted: { authorization: "sealed-header-value" },
      },
      {
        id: "public-docs",
        name: "Public docs",
        url: "https://mcp.example.test/docs",
        allowedTools: null,
        timeoutMs: null,
        cacheToolsList: false,
      },
    ],
  });
  // Settings changed after creation carry over too.
  await shared.admin`update sessions set keep_live = true, title = 'Release plan',
    title_source = 'user' where id = ${session.id}`;
  return session.id;
}

async function sessionRow(sessionId: string): Promise<Row> {
  const [row] = await shared.admin<Array<{ row: Row }>>`
    select to_jsonb(session_row) as row from sessions session_row where id = ${sessionId}`;
  if (!row) throw new Error(`session ${sessionId} is missing`);
  return row.row;
}

async function mcpServers(sessionId: string) {
  const rows = await shared.admin<Array<{ row: Row }>>`
    select to_jsonb(server_row) - 'id' - 'session_id' - 'created_at' - 'updated_at' as row
    from session_mcp_servers server_row where session_id = ${sessionId} order by server_id`;
  return rows.map((row) => row.row);
}

async function membershipId(org: Org, subjectId: string) {
  const [row] = await shared.admin<Array<{ id: string }>>`
    select id from organization_memberships
    where account_id = ${org.accountId} and subject_id = ${subjectId}`;
  if (!row) throw new Error(`no membership for ${subjectId}`);
  return row.id;
}

/** Appends one completed exchange so a message-boundary fork has a point to fork at. */
async function completedExchange(org: Org, sessionId: string) {
  const [next] = await shared.admin<Array<{ sequence: number; position: number }>>`
    select session_row.last_sequence + 1 as sequence,
      (select coalesce(max(turn_row.position), 0)::int + 1 from session_turns turn_row
        where turn_row.session_id = session_row.id) as position
    from sessions session_row where session_row.id = ${sessionId}`;
  if (!next) throw new Error(`session ${sessionId} is missing`);
  const { sequence, position } = next;
  const turnId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await shared.admin`insert into session_turns (
    id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
    status, position, prompt, model, reasoning_effort, sandbox_backend
  ) values (${turnId}, ${org.accountId}, ${org.workspaceId}, ${sessionId}, ${eventId},
    'fork-parity-test', 'completed', ${position}, 'Next step?', 'test-model', 'high', 'none')`;
  await shared.admin`insert into session_events (
    id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
  ) values (${eventId}, ${org.accountId}, ${org.workspaceId}, ${sessionId}, ${turnId},
    ${sequence}, 'user.message', '{"text":"Next step?"}')`;
  await shared.admin`update sessions set last_sequence = ${sequence} where id = ${sessionId}`;
  await shared.admin`insert into session_history_items (
    account_id, workspace_id, session_id, turn_id, position, item
  ) values (${org.accountId}, ${org.workspaceId}, ${sessionId}, ${turnId}, ${position},
    ${shared.admin.json({ type: "message", role: "user", content: "Next step?" })})`;
  return eventId;
}

async function expectSameAgent(
  org: Org,
  sourceId: string,
  forkId: string,
  actor: string,
): Promise<Context> {
  const [source, fork] = await Promise.all([sessionRow(sourceId), sessionRow(forkId)]);
  const columns = Object.keys(source).sort();
  const classified = [...COPIED, ...Object.keys(OWN)].sort();
  // Every column is classified exactly once.
  expect(new Set(classified).size).toBe(classified.length);
  expect(classified).toEqual(columns);

  const context: Context = {
    source,
    fork,
    actor,
    actorMembershipId: await membershipId(org, actor),
  };
  const copied = Object.fromEntries(COPIED.map((column) => [column, fork[column]]));
  expect(copied).toEqual(Object.fromEntries(COPIED.map((column) => [column, source[column]])));
  const own = Object.fromEntries(Object.keys(OWN).map((column) => [column, fork[column]]));
  expect(own).toEqual(
    Object.fromEntries(
      Object.entries(OWN).map(([column, rule]) => [column, rule.expected(context)]),
    ),
  );
  return context;
}

describe("a fork is the same agent as its source", () => {
  test("the source fixture differs from a plain session in every agent setting", async () => {
    const org = await organization();
    const sourceId = await configuredSource(org);
    const plain = await createSession(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: org.owner },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const [source, blank] = await Promise.all([sessionRow(sourceId), sessionRow(plain.id)]);
    for (const column of [
      "tools",
      "tool_policy",
      "first_party_mcp_tools",
      "first_party_mcp_permissions",
      "agent_config",
      "metadata",
      "initial_xai_provider_account_authority_snapshot",
      "initial_claude_provider_account_authority_snapshot",
      "code_search_enabled",
      "agent_access",
      "memory_scope",
      "vault_policy",
      "keep_live",
      "instructions",
      "max_nested_agent_depth_override",
    ]) {
      expect({ column, value: source[column] }).not.toEqual({ column, value: blank[column] });
    }
    expect(source.scope_subject_id).toBe(org.owner);
  }, 180_000);

  test("the owner's whole-session fork keeps every agent setting", async () => {
    const org = await organization();
    const sourceId = await configuredSource(org);
    await completedExchange(org, sourceId);
    const fork = await forkSessionContent(client.db, {
      sourceWorkspaceId: org.workspaceId,
      sourceSessionId: sourceId,
      actorSubjectId: org.owner,
      destinationWorkspaceId: org.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    expect(fork.copiedHistoryItemCount).toBeGreaterThan(0);
    const { fork: row } = await expectSameAgent(org, sourceId, fork.sessionId, org.owner);
    expect(row.created_by_context).not.toHaveProperty("sourceEventId");
    expect(await mcpServers(fork.sessionId)).toEqual(await mcpServers(sourceId));
    expect(await mcpServers(fork.sessionId)).toHaveLength(2);
  }, 180_000);

  test("a message-boundary fork keeps every agent setting", async () => {
    const org = await organization();
    const sourceId = await configuredSource(org);
    const firstEventId = await completedExchange(org, sourceId);
    await completedExchange(org, sourceId);
    const fork = await forkSessionContent(client.db, {
      sourceWorkspaceId: org.workspaceId,
      sourceSessionId: sourceId,
      actorSubjectId: org.owner,
      destinationWorkspaceId: org.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
      sourceEventId: firstEventId,
    });
    expect(fork.copiedHistoryItemCount).toBe(1);
    const { fork: row } = await expectSameAgent(org, sourceId, fork.sessionId, org.owner);
    expect(row.created_by_context).toMatchObject({ sourceEventId: firstEventId });
    expect(await mcpServers(fork.sessionId)).toEqual(await mcpServers(sourceId));
  }, 180_000);

  test("another member's fork keeps the agent and rebinds what belongs to the person", async () => {
    const org = await organization();
    const sourceId = await configuredSource(org);
    const fork = await forkSessionContent(client.db, {
      sourceWorkspaceId: org.workspaceId,
      sourceSessionId: sourceId,
      actorSubjectId: org.member,
      destinationWorkspaceId: org.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    const { fork: row } = await expectSameAgent(org, sourceId, fork.sessionId, org.member);
    expect(row.owner_subject_id).toBe(org.member);
    expect(row.scope_subject_id).toBe(org.member);
    // Headers the source's creator supplied are their credentials.
    expect(await mcpServers(fork.sessionId)).toEqual(
      (await mcpServers(sourceId)).filter((server) => server.server_id === "public-docs"),
    );
  }, 180_000);
});
