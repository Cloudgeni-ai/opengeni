// Organization (Console) agents at runtime against real PostgreSQL (app role,
// RLS): the visibility gate and reach, the session binding written on create,
// worker chats inheriting it, the claim gate, the per-turn version pin,
// Instructions delivered after a move and folded by compaction, end-user
// login refresh under SKIP LOCKED, and the publish move's candidates. A chat
// without an organization agent keeps today's row, prompt and claim.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  agentInstructionsContextText,
  parseAgentInstructionsContextText,
  readAgentInstructionsContext,
} from "@opengeni/contracts";
import {
  applyContextCompaction,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureSessionAgentInstructions,
  getActiveSessionHistoryItems,
  getSession,
  isSessionEventPersistenceError,
  listOrgAgentMoveCandidates,
  listOrgAgentMoveWorkspaces,
  readEndUserToolCredential,
  readOrgAgentForSessionCreate,
  readSessionAgentPrompt,
  readSessionOrgAgentState,
  readSessionOrgAgentVersion,
  refreshEndUserToolCredential,
  saveInlineOrgAgentVersion,
  submitHumanPromptInTransaction,
  withOrgAgentsVisible,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { rawRows, withRlsContext } from "../src/database";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("organization-agent-runtime");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type VersionSeed = { instructions: string; config?: Record<string, unknown> };

/** An organization whose bootstrap workspace is a managed (Console) workspace. */
async function organization() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "org agents",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "org agents",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const subjectId = grant.subjectId;
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${workspaceId}, 'console')`;

  async function workspace(source: "console" | "console_test" | null) {
    const id = crypto.randomUUID();
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'Other')`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
    if (source) {
      await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
        values (${accountId}, ${id}, ${source})`;
    }
    return id;
  }

  async function agent(
    key: string,
    versions: VersionSeed[],
    options: { published?: number | null; managedBy?: "console" | "code"; archived?: boolean } = {},
  ) {
    const id = crypto.randomUUID();
    await shared.admin`insert into agents (id, account_id, workspace_id, scope, visibility, name,
        name_key, origin, current_revision, agent_key, managed_by, published_revision, archived_at)
      values (${id}, ${accountId}, null, 'organization', 'workspace', ${key}, ${key}, 'app',
        ${versions.length}, ${key}, ${options.managedBy ?? "console"},
        ${options.published === undefined ? versions.length : options.published},
        ${options.archived ? new Date() : null})`;
    for (const [index, version] of versions.entries()) {
      const config = version.config ?? {};
      await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
          name, instructions, config, tool_catalog, source, config_hash)
        values (${id}, ${accountId}, null, ${index + 1}, ${key}, ${version.instructions},
          ${JSON.stringify(config)}::text::jsonb, '{}'::jsonb, 'console',
          ${hash(`${id}:${index}`)})`;
    }
    return id;
  }

  async function chat(
    orgAgent: {
      agentId: string;
      version: number;
      promptVersion: number | null;
      overrides?: Record<string, { agent: unknown; chat: unknown }> | null;
    } | null,
    extra: Record<string, unknown> = {},
  ) {
    return await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(orgAgent ? { orgAgent: { overrides: null, ...orgAgent } } : {}),
      ...extra,
    });
  }

  async function prompt(sessionId: string) {
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId,
        workspaceId,
        sessionId,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "work",
        resources: [],
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
      }),
    );
  }
  const claimInput = (sessionId: string) => ({
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" as const },
  });
  async function claim(sessionId: string, prompted = false) {
    if (!prompted) await prompt(sessionId);
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      ...claimInput(sessionId),
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    if (result.action !== "claimed") throw new Error(`not claimed: ${result.action}`);
    return result.turn;
  }
  type Turn = Awaited<ReturnType<typeof claim>>;
  const identity = (sessionId: string, turn: Turn) => ({
    accountId,
    workspaceId,
    sessionId,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
  });
  const turnRef = (turn: Turn) => ({
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
  });
  const settle = (sessionId: string, turn: Turn) =>
    applySessionTurnSettlement(client.db, workspaceId, {
      sessionId,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
  const readPrompt = (sessionId: string, turn?: Turn) =>
    readSessionAgentPrompt(client.db, {
      accountId,
      workspaceId,
      sessionId,
      ...(turn ? { turn: turnRef(turn) } : {}),
    });
  async function deliver(sessionId: string, turn: Turn) {
    const current = await readPrompt(sessionId, turn);
    if (!current) throw new Error("no agent prompt");
    return ensureSessionAgentInstructions(client.db, { ...identity(sessionId, turn), prompt: current });
  }
  const delivered = async (sessionId: string) =>
    (await getActiveSessionHistoryItems(client.db, workspaceId, sessionId))
      .map((row) => readAgentInstructionsContext(row.item))
      .filter((value) => value !== null)
      .map((text) => parseAgentInstructionsContextText(text));
  const row = async (sessionId: string) =>
    (
      await shared.admin<
        {
          agent_id: string | null;
          agent_version: number | null;
          agent_prompt_version: number | null;
          agent_prompt_revision: number | null;
          agent_overrides: unknown;
        }[]
      >`select agent_id::text, agent_version, agent_prompt_version, agent_prompt_revision,
          agent_overrides from sessions where id = ${sessionId}`
    )[0]!;
  return {
    accountId,
    workspaceId,
    subjectId,
    scope: { accountId, workspaceId },
    workspace,
    agent,
    chat,
    prompt,
    claimInput,
    claim,
    identity,
    turnRef,
    settle,
    readPrompt,
    deliver,
    delivered,
    row,
  };
}

describe("organization agents at runtime", () => {
  test("organization agents are hidden unless the transaction opts in; reach", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [{ instructions: "Be kind." }]);
    const count = (visible: boolean) =>
      withRlsContext(client.db, org.scope, async (tx) => {
        const read = () =>
          rawRows<{ count: number }>(
            tx,
            sql`select count(*)::int as count from agents where id = ${agentId}::uuid`,
          );
        const [result] = visible ? await withOrgAgentsVisible(tx, read) : await read();
        return Number(result?.count ?? 0);
      });
    expect(await count(false)).toBe(0);
    expect(await count(true)).toBe(1);

    expect(
      await readOrgAgentForSessionCreate(client.db, { ...org.scope, ref: { key: "support" } }),
    ).toMatchObject({
      agent: { id: agentId, key: "support", publishedVersion: 1, currentVersion: 1, archived: false },
      reach: { managedSource: "console", access: false },
    });
    const other = await org.workspace(null);
    const outside = await readOrgAgentForSessionCreate(client.db, {
      accountId: org.accountId,
      workspaceId: other,
      ref: { id: agentId },
    });
    expect(outside.reach).toEqual({ managedSource: null, access: false });
    await shared.admin`insert into agent_workspace_access (agent_id, account_id, workspace_id)
      values (${agentId}, ${org.accountId}, ${other})`;
    expect(
      (
        await readOrgAgentForSessionCreate(client.db, {
          accountId: org.accountId,
          workspaceId: other,
          ref: { id: agentId },
        })
      ).reach,
    ).toEqual({ managedSource: null, access: true });
    // Another organization never sees it.
    const stranger = await organization();
    expect(
      (await readOrgAgentForSessionCreate(client.db, { ...stranger.scope, ref: { key: "support" } }))
        .agent,
    ).toBeNull();
  }, 180_000);

  test("create writes the binding; a chat without an organization agent keeps today's row", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [{ instructions: "Be kind." }]);
    const overrides = { model: { agent: "gpt-5", chat: "scripted-model" } };
    const session = await org.chat({ agentId, version: 1, promptVersion: 1, overrides });
    expect(await org.row(session.id)).toEqual({
      agent_id: agentId,
      agent_version: 1,
      agent_prompt_version: 1,
      agent_prompt_revision: null,
      agent_overrides: overrides,
    });
    const read = await getSession(client.db, org.workspaceId, session.id);
    expect(read?.orgAgent).toEqual({ id: agentId, key: "support", version: 1, overrides });
    // agentId keeps its meaning: workspace agents only.
    expect(read?.agentId).toBeNull();

    const plain = await org.chat(null);
    expect(await org.row(plain.id)).toEqual({
      agent_id: null,
      agent_version: null,
      agent_prompt_version: null,
      agent_prompt_revision: null,
      agent_overrides: null,
    });
    const plainRead = await getSession(client.db, org.workspaceId, plain.id);
    // Serialized exactly as before: no orgAgent key at all.
    expect(plainRead && Object.hasOwn(plainRead, "orgAgent")).toBe(false);
    expect(await org.readPrompt(plain.id)).toBeNull();
    // The claim gate leaves it alone: a worker without the protocol claims it.
    await org.prompt(plain.id);
    expect(
      await claimSessionWorkForAttempt(client.db, org.workspaceId, org.claimInput(plain.id)),
    ).toMatchObject({ action: "claimed" });
    // A workspace agent chat reads exactly today's prompt shape.
    const workspaceAgent = crypto.randomUUID();
    await shared.admin`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
        origin, current_revision)
      values (${workspaceAgent}, ${org.accountId}, ${org.workspaceId}, 'workspace', 'Helper',
        'helper', 'app', 1)`;
    await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
        name, instructions)
      values (${workspaceAgent}, ${org.accountId}, ${org.workspaceId}, 1, 'Helper', 'Be brief.')`;
    const helper = await org.chat(null);
    await shared.admin`update sessions set agent_id = ${workspaceAgent}, agent_prompt_revision = 1
      where id = ${helper.id}`;
    expect(await org.readPrompt(helper.id)).toStrictEqual({
      agentId: workspaceAgent,
      revision: 1,
      instructions: "Be brief.",
    });
  }, 180_000);

  test("the claim gate refuses a worker without the organization agent protocol", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [{ instructions: "Be kind." }]);
    const session = await org.chat({ agentId, version: 1, promptVersion: 1 });
    await org.prompt(session.id);
    const refused = await claimSessionWorkForAttempt(client.db, org.workspaceId, {
      ...org.claimInput(session.id),
      agentInstructionsProtocol: 1,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isSessionEventPersistenceError(refused)).toBe(true);
    if (!isSessionEventPersistenceError(refused)) throw refused;
    expect(refused.details).toMatchObject({ sqlState: "55000" });
    // A current worker claims the same accepted work.
    const turn = await org.claim(session.id, true);
    expect(turn.activeAttemptId).toBeTruthy();
  }, 180_000);

  test("worker chats inherit the agent; its Instructions only when shared", async () => {
    const org = await organization();
    const quiet = await org.agent("quiet", [{ instructions: "Be quiet." }]);
    const sharing = await org.agent("sharing", [
      { instructions: "Share me.", config: { workers: { shareInstructions: true } } },
    ]);
    for (const [agentId, expectedPrompt] of [
      [quiet, null],
      [sharing, 1],
    ] as const) {
      const overrides = { model: { agent: null, chat: "scripted-model" } };
      const parent = await org.chat({ agentId, version: 1, promptVersion: 1, overrides });
      const turn = await org.claim(parent.id);
      const child = await org.chat(null, {
        parentSessionId: parent.id,
        createdByActor: {
          type: "agent_attempt",
          attemptId: turn.activeAttemptId!,
          sessionId: parent.id,
          turnId: turn.id,
          executionGeneration: turn.executionGeneration,
        },
      });
      expect(await org.row(child.id)).toEqual({
        agent_id: agentId,
        agent_version: 1,
        agent_prompt_version: expectedPrompt,
        agent_prompt_revision: null,
        agent_overrides: overrides,
      });
      const prompt = await org.readPrompt(child.id);
      if (expectedPrompt === null) expect(prompt).toBeNull();
      else expect(prompt).toMatchObject({ agentId, revision: 1, instructions: "Share me." });
      await org.settle(parent.id, turn);
    }
    // A plain parent's worker stays plain.
    const plain = await org.chat(null);
    const turn = await org.claim(plain.id);
    const child = await org.chat(null, {
      parentSessionId: plain.id,
      createdByActor: {
        type: "agent_attempt",
        attemptId: turn.activeAttemptId!,
        sessionId: plain.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
      },
    });
    expect((await org.row(child.id)).agent_version).toBeNull();
  }, 180_000);

  test("a moved chat gets the newer Instructions as one history item; compaction folds them", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [
      { instructions: "Answer in French." },
      { instructions: "Answer in German." },
      { instructions: "Answer in Spanish." },
    ]);
    const session = await org.chat({ agentId, version: 1, promptVersion: 1 });
    const first = await org.claim(session.id);
    expect(await org.readPrompt(session.id, first)).toEqual({
      agentId,
      revision: 1,
      instructions: "Answer in French.",
      orgVersion: 1,
    });
    expect(await org.deliver(session.id, first)).toBeNull();
    // A move during the turn changes nothing for it: the version is pinned.
    await shared.admin`update sessions set agent_version = 2 where id = ${session.id}`;
    expect(
      await readSessionOrgAgentVersion(client.db, {
        ...org.scope,
        sessionId: session.id,
        turn: org.turnRef(first),
      }),
    ).toEqual({ agentId, version: 1 });
    expect(await org.deliver(session.id, first)).toBeNull();
    await org.settle(session.id, first);

    const second = await org.claim(session.id);
    expect(
      await readSessionOrgAgentVersion(client.db, {
        ...org.scope,
        sessionId: session.id,
        turn: org.turnRef(second),
      }),
    ).toEqual({ agentId, version: 2 });
    expect(await org.readPrompt(session.id, second)).toMatchObject({ revision: 1, orgVersion: 2 });
    const german = agentInstructionsContextText({
      kind: "revision",
      revision: 2,
      instructions: "Answer in German.",
    });
    expect(await org.deliver(session.id, second)).toBe(german);
    // A retry replays the same item.
    expect(await org.deliver(session.id, second)).toBe(german);
    expect(await org.delivered(session.id)).toEqual([
      { kind: "revision", revision: 2, instructions: "Answer in German." },
    ]);

    // Compaction folds the version into the prompt, never past agent_version.
    const compact = (revision: number) =>
      applyContextCompaction(client.db, {
        ...org.identity(session.id, second),
        replacementItems: [],
        summaryItem: { type: "compaction", encrypted_content: `summary ${revision}` },
        agentPromptRevision: revision,
      });
    expect((await compact(3)).applied).toBe(true);
    expect((await org.row(session.id)).agent_prompt_version).toBe(1);
    expect((await compact(2)).applied).toBe(true);
    expect((await org.row(session.id)).agent_prompt_version).toBe(2);
    // The turn's later attempts keep the prompt it started with.
    expect(await org.readPrompt(session.id, second)).toMatchObject({ revision: 1 });
    await org.settle(session.id, second);
    const third = await org.claim(session.id);
    expect(await org.readPrompt(session.id, third)).toEqual({
      agentId,
      revision: 2,
      instructions: "Answer in German.",
      orgVersion: 2,
    });
    expect(await org.deliver(session.id, third)).toBeNull();

    // A rollback publish moves to a lower version; the fold follows it.
    await shared.admin`update sessions set agent_version = 1 where id = ${session.id}`;
    expect((await compact(1)).applied).toBe(false); // the third turn's fence, not the second's
    const rollback = await applyContextCompaction(client.db, {
      ...org.identity(session.id, third),
      replacementItems: [],
      summaryItem: { type: "compaction", encrypted_content: "rollback" },
      agentPromptRevision: 1,
    });
    expect(rollback.applied).toBe(true);
    expect((await org.row(session.id)).agent_prompt_version).toBe(1);

    // A worker chat without the agent layer never gains one.
    const noLayer = await org.chat({ agentId, version: 2, promptVersion: null });
    const turn = await org.claim(noLayer.id);
    expect(await org.readPrompt(noLayer.id, turn)).toBeNull();
    await applyContextCompaction(client.db, {
      ...org.identity(noLayer.id, turn),
      replacementItems: [],
      summaryItem: { type: "compaction", encrypted_content: "summary" },
      agentPromptRevision: 2,
    });
    expect((await org.row(noLayer.id)).agent_prompt_version).toBeNull();
  }, 180_000);

  test("inline config versions: create, reuse by hash, and refusals", async () => {
    const org = await organization();
    const definition = {
      name: "Coder",
      description: "",
      instructions: "Write code.",
      config: { toolServers: [], workers: { shareInstructions: false } },
    };
    const save = (input: { key?: string; id?: string; configHash: string; mayWrite: boolean }) =>
      saveInlineOrgAgentVersion(client.db, {
        ...org.scope,
        ref: input.id ? { id: input.id } : { key: input.key! },
        definition,
        toolCatalog: {},
        configHash: input.configHash,
        subjectId: org.subjectId,
        mayWrite: input.mayWrite,
      });
    expect(await save({ key: "coder", configHash: hash("a"), mayWrite: false })).toEqual({
      outcome: "forbidden",
    });
    const created = await save({ key: "coder", configHash: hash("a"), mayWrite: true });
    expect(created).toMatchObject({
      outcome: "created_agent",
      agent: { key: "coder", managedBy: "code", publishedVersion: null },
      version: { version: 1, source: "inline", configHash: hash("a") },
    });
    // The same config reuses its version, even without write permission.
    expect(await save({ key: "coder", configHash: hash("a"), mayWrite: false })).toMatchObject({
      outcome: "reused",
      version: { version: 1 },
    });
    expect(await save({ key: "coder", configHash: hash("b"), mayWrite: false })).toEqual({
      outcome: "forbidden",
    });
    expect(await save({ key: "coder", configHash: hash("b"), mayWrite: true })).toMatchObject({
      outcome: "created_version",
      agent: { currentVersion: 2, publishedVersion: null },
      version: { version: 2, source: "inline" },
    });
    await org.agent("console-agent", [{ instructions: "Hi." }]);
    expect(
      await save({ key: "console-agent", configHash: hash("c"), mayWrite: true }),
    ).toMatchObject({ outcome: "managed_in_console" });
    expect(
      await save({ id: crypto.randomUUID(), configHash: hash("d"), mayWrite: true }),
    ).toEqual({ outcome: "not_found" });
  }, 180_000);

  test("end-user login refresh runs under SKIP LOCKED and records failures", async () => {
    const org = await organization();
    const [server] = await shared.admin<{ id: string }[]>`
      insert into organization_tool_servers (account_id, server_key, name, url, auth_mode, oauth_refresh)
      values (${org.accountId}, 'crm', 'CRM', 'https://crm.example.com/mcp', 'per_user',
        ${JSON.stringify({ tokenUrl: "https://crm.example.com/token", clientId: "c" })}::text::jsonb)
      returning id::text`;
    const subjectId = "external_user:alice";
    const [credential] = await shared.admin<{ id: string }[]>`
      insert into end_user_tool_credentials (account_id, workspace_id, end_user_subject_id,
        tool_server_id, kind, material_encrypted, expires_at)
      values (${org.accountId}, ${org.workspaceId}, ${subjectId}, ${server!.id}, 'oauth',
        'old-material', now() + interval '1 minute')
      returning id::text`;
    const credentialId = credential!.id;
    let calls = 0;
    const refresh = (result: { materialEncrypted: string; expiresAt: Date | null } | null) =>
      refreshEndUserToolCredential(client.db, {
        ...org.scope,
        credentialId,
        refreshBefore: new Date(Date.now() + 5 * 60_000),
        refresh: async () => {
          calls += 1;
          return result;
        },
      });
    // Another worker holds the row: this one does not wait or refresh.
    const locked = await shared.admin.begin(async (tx) => {
      await tx`select id from end_user_tool_credentials where id = ${credentialId} for update`;
      return await refresh({ materialEncrypted: "never", expiresAt: null });
    });
    expect(locked).toEqual({ outcome: "locked" });
    expect(calls).toBe(0);

    const refreshed = await refresh({
      materialEncrypted: "new-material",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(refreshed).toMatchObject({
      outcome: "refreshed",
      credential: { materialEncrypted: "new-material", version: 2, refreshFailedAt: null },
    });
    expect(calls).toBe(1);
    // Already fresh (another worker refreshed it): nothing to do.
    expect(await refresh(null)).toMatchObject({ outcome: "current" });
    expect(calls).toBe(1);

    await shared.admin`update end_user_tool_credentials set expires_at = now() - interval '1 minute'
      where id = ${credentialId}`;
    const failed = await refresh(null);
    expect(failed.outcome).toBe("failed");
    const stored = await readEndUserToolCredential(client.db, {
      ...org.scope,
      subjectId,
      toolServerId: server!.id,
    });
    expect(stored?.refreshFailedAt).toBeInstanceOf(Date);
    expect(stored?.materialEncrypted).toBe("new-material");
    const [used] = await shared.admin<{ last_used_at: Date | null }[]>`
      select last_used_at from end_user_tool_credentials where id = ${credentialId}`;
    expect(used?.last_used_at).toBeInstanceOf(Date);

    expect(
      await refreshEndUserToolCredential(client.db, {
        ...org.scope,
        credentialId: crypto.randomUUID(),
        refreshBefore: new Date(),
        refresh: async () => null,
      }),
    ).toEqual({ outcome: "missing" });
  }, 180_000);

  test("publish move candidates: other versions, busy chats flagged, Console test excluded", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [{ instructions: "v1" }, { instructions: "v2" }]);
    const idle = await org.chat({ agentId, version: 1, promptVersion: 1 });
    const busy = await org.chat({ agentId, version: 1, promptVersion: 1 });
    const current = await org.chat({ agentId, version: 2, promptVersion: 2 });
    await org.chat(null);
    await org.claim(busy.id);
    const candidates = await listOrgAgentMoveCandidates(client.db, {
      ...org.scope,
      agentId,
      toVersion: 2,
      afterSessionId: null,
      limit: 500,
    });
    expect(candidates).toEqual(
      [
        { sessionId: idle.id, version: 1, busy: false },
        { sessionId: busy.id, version: 1, busy: true },
      ].sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1)),
    );
    expect(candidates.some((candidate) => candidate.sessionId === current.id)).toBe(false);
    // Paging by id.
    const first = candidates[0]!.sessionId;
    expect(
      await listOrgAgentMoveCandidates(client.db, {
        ...org.scope,
        agentId,
        toVersion: 2,
        afterSessionId: first,
        limit: 500,
      }),
    ).toEqual(candidates.slice(1));
    expect(
      await readSessionOrgAgentState(client.db, { ...org.scope, sessionId: idle.id }),
    ).toEqual({ agentId, version: 1, promptVersion: 1, overrides: null });

    const testWorkspace = await org.workspace("console_test");
    const added = await org.workspace(null);
    await org.workspace(null);
    await shared.admin`insert into agent_workspace_access (agent_id, account_id, workspace_id)
      values (${agentId}, ${org.accountId}, ${added})`;
    const workspaces = await listOrgAgentMoveWorkspaces(client.db, {
      accountId: org.accountId,
      agentId,
    });
    expect(workspaces.sort()).toEqual([org.workspaceId, added].sort());
    expect(workspaces).not.toContain(testWorkspace);
  }, 180_000);
});
