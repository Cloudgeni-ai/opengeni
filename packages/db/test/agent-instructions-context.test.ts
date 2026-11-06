import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  agentInstructionsContextText,
  parseAgentInstructionsContextText,
  readAgentInstructionsContext,
} from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionAgentInstructions,
  readSessionAgentPrompt,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  applyContextCompaction,
  isSessionEventPersistenceError,
} from "../src/index";
import { rawRows, withSessionRlsActorContext } from "../src/database";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("agent-instructions-context");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/**
 * A chat, optionally bound to a new agent at revision 1 (what PR3's session
 * creation does): sessions.agent_id and agent_prompt_revision.
 */
async function fixture(options: { agent?: string; onlyMe?: boolean } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "agents",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "agents",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const subjectId = grant.subjectId;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const agentId = crypto.randomUUID();
  if (options.agent !== undefined) {
    await shared.admin`
      insert into agents (id, account_id, workspace_id, visibility, owner_subject_id, name,
        name_key, origin, current_revision)
      values (${agentId}, ${accountId}, ${workspaceId},
        ${options.onlyMe ? "private" : "workspace"}, ${options.onlyMe ? subjectId : null},
        'Helper', 'helper', 'app', 1)`;
    await shared.admin`
      insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
        instructions, first_message)
      values (${agentId}, ${accountId}, ${workspaceId}, 1, 'Helper', ${options.agent}, '')`;
    await shared.admin`
      update sessions set agent_id = ${agentId}, agent_prompt_revision = 1
      where id = ${session.id}`;
    // An Only me agent serves only its owner's Only me chats.
    // (Set directly: the tenancy transition itself is not under test here.)
    if (options.onlyMe) {
      const personal = crypto.randomUUID();
      await shared.admin`insert into workspaces (id, account_id, name)
        values (${personal}, ${accountId}, 'Personal')`;
      await shared.admin`insert into organization_memberships
          (account_id, subject_id, role, status, personal_workspace_id)
        values (${accountId}, ${subjectId}, 'member', 'active', ${personal})
        on conflict do nothing`;
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`
          update sessions set visibility = 'user_private', owner_subject_id = ${subjectId},
            owner_organization_membership_id = (select id from organization_memberships
              where account_id = ${accountId} and subject_id = ${subjectId})
          where id = ${session.id}`;
      });
    }
  }
  /** A new agent revision, as an edit in the app writes it. */
  async function edit(instructions: string, firstMessage = "") {
    await shared.admin.begin(async (tx) => {
      const [row] = await tx<{ revision: number }[]>`
        update agents set current_revision = current_revision + 1, updated_at = now()
        where id = ${agentId} returning current_revision as revision`;
      await tx`
        insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
          instructions, first_message)
        values (${agentId}, ${accountId}, ${workspaceId}, ${row!.revision}, 'Helper',
          ${instructions}, ${firstMessage})`;
    });
  }
  const deleteAgent = () => shared.admin`delete from agents where id = ${agentId}`;
  async function prompt() {
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId,
        workspaceId,
        sessionId: session.id,
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
  const claimInput = () => ({
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" as const },
  });
  async function claim(prompted = false) {
    if (!prompted) await prompt();
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      ...claimInput(),
      agentInstructionsProtocol: 1,
    });
    if (result.action !== "claimed") throw new Error(`not claimed: ${result.action}`);
    return result.turn;
  }
  type Turn = Awaited<ReturnType<typeof claim>>;
  const identity = (turn: Turn) => ({
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
  });
  const settle = (turn: Turn) =>
    applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
  const scope = { accountId, workspaceId, sessionId: session.id };
  /** With a turn, as the worker reads it: frozen for the turn's attempts. */
  const readPrompt = (turn?: Turn) =>
    readSessionAgentPrompt(client.db, {
      ...scope,
      ...(turn
        ? {
            turn: {
              turnId: turn.id,
              expectedExecutionGeneration: turn.executionGeneration,
              expectedAttemptId: turn.activeAttemptId!,
            },
          }
        : {}),
    });
  /** What the worker does before building the turn's agent. */
  async function deliver(turn: Turn) {
    const current = await readPrompt(turn);
    if (!current) throw new Error("not an agent chat");
    return ensureSessionAgentInstructions(client.db, { ...identity(turn), prompt: current });
  }
  const history = () => getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  const delivered = async () =>
    (await history())
      .map((row) => readAgentInstructionsContext(row.item))
      .filter((value) => value !== null)
      .map((text) => parseAgentInstructionsContextText(text));
  const promptRevision = async () =>
    (
      await shared.admin<{ revision: number | null }[]>`
        select agent_prompt_revision as revision from sessions where id = ${session.id}`
    )[0]!.revision;
  return {
    agentId,
    subjectId,
    scope,
    edit,
    deleteAgent,
    prompt,
    claimInput,
    claim,
    identity,
    settle,
    readPrompt,
    deliver,
    history,
    delivered,
    promptRevision,
  };
}

test("a plain chat reads no agent prompt", async () => {
  const f = await fixture();
  expect(await f.readPrompt()).toBeNull();
}, 180_000);

test("an edit becomes one history item before the turn that first sees it; retries replay it", async () => {
  const f = await fixture({ agent: "Answer in French." });
  expect(await f.readPrompt()).toEqual({
    agentId: f.agentId,
    revision: 1,
    instructions: "Answer in French.",
  });

  // The system prompt already carries revision 1: nothing is written, and the
  // turn stays frozen without an item even when an edit lands mid-turn.
  const first = await f.claim();
  expect(await f.deliver(first)).toBeNull();
  await f.edit("Answer in German.");
  expect(await f.deliver(first)).toBeNull();
  expect(await f.delivered()).toEqual([]);
  await f.settle(first);

  // The next turn sees revision 2 once, before its user message.
  const second = await f.claim();
  const text = agentInstructionsContextText({
    kind: "revision",
    revision: 2,
    instructions: "Answer in German.",
  });
  expect(await f.deliver(second)).toBe(text);
  const written = await f.history();
  expect(readAgentInstructionsContext(written.at(-2)!.item)).toBe(text);
  expect(written.at(-2)!.item.role).toBe("developer");
  expect(written.at(-1)!.item.role).toBe("user");
  // A retry of the same turn replays the frozen item, even after another edit.
  await f.edit("Answer in Spanish.");
  expect(await f.deliver(second)).toBe(text);
  expect(await f.history()).toEqual(written);
  await f.settle(second);

  const third = await f.claim();
  expect(await f.deliver(third)).toContain("Answer in Spanish.");
  await f.settle(third);

  // Unchanged instructions write nothing, and so does a revision that changed
  // only the first message.
  const fourth = await f.claim();
  expect(await f.deliver(fourth)).toContain("Answer in Spanish.");
  await f.settle(fourth);
  await f.edit("Answer in Spanish.", "Hola");
  const fifth = await f.claim();
  expect(await f.deliver(fifth)).toContain("(revision 3)");
  await f.settle(fifth);
  expect(
    (await f.delivered()).map((context) => context?.kind === "revision" && context.revision),
  ).toEqual([2, 3]);

  // Editing back to what the system prompt shows is still an edit: the newest
  // item replaces the earlier ones.
  await f.edit("Answer in French.");
  const sixth = await f.claim();
  expect(await f.deliver(sixth)).toContain("Answer in French.");
  expect((await f.delivered()).at(-1)).toEqual({
    kind: "revision",
    revision: 5,
    instructions: "Answer in French.",
  });
}, 180_000);

test("a deleted agent leaves a plain chat and withdraws only an earlier edit item", async () => {
  const untouched = await fixture({ agent: "Be brief." });
  await untouched.deleteAgent();
  // The revision went with the agent: the chat continues without the layer.
  expect(await untouched.readPrompt()).toEqual({
    agentId: untouched.agentId,
    revision: 1,
    instructions: null,
  });
  const turn = await untouched.claim();
  expect(await untouched.deliver(turn)).toBeNull();
  expect(await untouched.delivered()).toEqual([]);

  const edited = await fixture({ agent: "Be brief." });
  await edited.edit("Be thorough.");
  const first = await edited.claim();
  expect(await edited.deliver(first)).toContain("Be thorough.");
  await edited.settle(first);
  await edited.deleteAgent();
  const second = await edited.claim();
  expect(await edited.deliver(second)).toBe(agentInstructionsContextText({ kind: "deleted" }));
  await edited.settle(second);
  const third = await edited.claim();
  expect(await edited.deliver(third)).toBe(agentInstructionsContextText({ kind: "deleted" }));
  expect((await edited.delivered()).map((context) => context?.kind)).toEqual([
    "revision",
    "deleted",
  ]);
}, 180_000);

test("an Only me agent serves its owner's Only me chat; shared later, it is a plain chat", async () => {
  const f = await fixture({ agent: "Be brief.", onlyMe: true });
  await f.edit("Be thorough.");
  const actor = (initiatingHumanSubjectId: string | null) => ({
    subjectId: "service:agent-turn",
    initiatingHumanSubjectId,
  });
  const thorough = agentInstructionsContextText({
    kind: "revision",
    revision: 2,
    instructions: "Be thorough.",
  });
  const owned = await f.claim();
  await withSessionRlsActorContext(actor(f.subjectId), async () => {
    expect(await f.readPrompt(owned)).toEqual({
      agentId: f.agentId,
      revision: 1,
      instructions: "Be brief.",
    });
    expect(await f.deliver(owned)).toBe(thorough);
  });
  await f.settle(owned);
  // Shared after it started (set directly; the transition is not under test).
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set visibility = 'workspace_shared', owner_subject_id = null,
        owner_organization_membership_id = null
      where id = ${f.scope.sessionId}`;
  });
  const deleted = agentInstructionsContextText({ kind: "deleted" });
  for (const human of [null, `someone-else-${crypto.randomUUID()}`]) {
    const turn = await f.claim();
    await withSessionRlsActorContext(actor(human), async () => {
      // The private Instructions never reach a shared chat.
      expect(await f.readPrompt(turn)).toEqual({
        agentId: f.agentId,
        revision: 1,
        instructions: null,
      });
      expect(await f.deliver(turn)).toBe(deleted);
    });
    await f.settle(turn);
  }
  // The earlier edit item is withdrawn once.
  expect((await f.delivered()).map((context) => context?.kind)).toEqual(["revision", "deleted"]);
}, 180_000);

test("every attempt of a turn builds the prompt its first attempt recorded", async () => {
  const f = await fixture({ agent: "Use metric units." });
  await f.edit("Use imperial units.");
  const turn = await f.claim();
  expect(await f.readPrompt(turn)).toMatchObject({ revision: 1 });
  // An in-turn compaction folds revision 2 into the session...
  await applyContextCompaction(client.db, {
    ...f.identity(turn),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "summary" },
    agentPromptRevision: 2,
  });
  expect(await f.promptRevision()).toBe(2);
  // ...but the turn's later attempts keep the system prompt it started with.
  expect(await f.readPrompt(turn)).toEqual({
    agentId: f.agentId,
    revision: 1,
    instructions: "Use metric units.",
  });
  expect(await f.readPrompt()).toMatchObject({ revision: 2 });
  await f.settle(turn);
  const next = await f.claim();
  expect(await f.readPrompt(next)).toMatchObject({
    revision: 2,
    instructions: "Use imperial units.",
  });

  // The fold only moves forward, and only to a revision of the chat's agent.
  for (const revision of [1, 99]) {
    expect(
      (
        await applyContextCompaction(client.db, {
          ...f.identity(next),
          replacementItems: [],
          summaryItem: { type: "compaction", encrypted_content: `summary ${revision}` },
          agentPromptRevision: revision,
        })
      ).applied,
    ).toBe(true);
    expect(await f.promptRevision()).toBe(2);
  }
  const other = await fixture({ agent: "Other agent." });
  await other.edit("Other agent, revision 2.");
  await other.edit("Other agent, revision 3.");
  // Revision 3 exists only for another agent.
  await applyContextCompaction(client.db, {
    ...f.identity(next),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "summary other" },
    agentPromptRevision: 3,
  });
  expect(await f.promptRevision()).toBe(2);
}, 180_000);

test("a revision with unchanged instructions and no earlier item writes nothing", async () => {
  const f = await fixture({ agent: "Hi." });
  await f.edit("Hi.", "Hello there");
  const turn = await f.claim();
  expect(await f.deliver(turn)).toBeNull();
  // The turn stays frozen without an item, even after a real edit.
  await f.edit("Bye.");
  expect(await f.deliver(turn)).toBeNull();
  expect(await f.delivered()).toEqual([]);
}, 180_000);

test("an agent whose current revision cannot be read changes nothing", async () => {
  const fresh = await fixture({ agent: "Be calm." });
  await shared.admin`update agents set current_revision = 9 where id = ${fresh.agentId}`;
  const turn = await fresh.claim();
  expect(await fresh.deliver(turn)).toBeNull();
  expect(await fresh.delivered()).toEqual([]);

  const edited = await fixture({ agent: "Be calm." });
  await edited.edit("Be loud.");
  const first = await edited.claim();
  const loud = await edited.deliver(first);
  expect(loud).toContain("Be loud.");
  await edited.settle(first);
  await shared.admin`update agents set current_revision = 9 where id = ${edited.agentId}`;
  const second = await edited.claim();
  expect(await edited.deliver(second)).toBe(loud);
  expect((await edited.delivered()).map((context) => context?.kind)).toEqual(["revision"]);
}, 180_000);

test("compaction folds the newest revision into the prompt atomically, under the attempt fence", async () => {
  const f = await fixture({ agent: "Use metric units." });
  await f.edit("Use imperial units.");
  const first = await f.claim();
  expect(await f.deliver(first)).toContain("Use imperial units.");
  await f.settle(first);

  const second = await f.claim();
  // A fenced compaction (stale attempt) changes nothing.
  const stale = await applyContextCompaction(client.db, {
    ...f.identity(second),
    expectedAttemptId: crypto.randomUUID(),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "stale" },
    agentPromptRevision: 2,
  });
  expect(stale.applied).toBe(false);
  expect(await f.promptRevision()).toBe(1);

  const compacted = await applyContextCompaction(client.db, {
    ...f.identity(second),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "summary" },
    agentPromptRevision: 2,
  });
  expect(compacted.applied).toBe(true);
  expect(await f.promptRevision()).toBe(2);
  expect(await f.delivered()).toEqual([]);
  await f.settle(second);

  // The next turn's system prompt carries revision 2; nothing more is written.
  expect(await f.readPrompt()).toMatchObject({ revision: 2, instructions: "Use imperial units." });
  const third = await f.claim();
  expect(await f.deliver(third)).toBeNull();
  expect(await f.delivered()).toEqual([]);
  await f.settle(third);

  // A plain chat never becomes an agent chat through compaction.
  const plain = await fixture();
  const turn = await plain.claim();
  expect(
    (
      await applyContextCompaction(client.db, {
        ...plain.identity(turn),
        replacementItems: [],
        summaryItem: { type: "compaction", encrypted_content: "summary" },
        agentPromptRevision: 7,
      })
    ).applied,
  ).toBe(true);
  expect(await plain.promptRevision()).toBeNull();
}, 180_000);

test("the claim gate refuses an agent chat to a worker without the protocol, without failing it", async () => {
  const f = await fixture({ agent: "Be kind." });
  await f.prompt();
  const refused = await claimSessionWorkForAttempt(
    client.db,
    f.scope.workspaceId,
    f.claimInput(),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  // The worker maps exactly this to a durable explicit-recheck admission
  // block (errors.ts preClaimAdmissionFailure), not a failed session.
  expect(isSessionEventPersistenceError(refused)).toBe(true);
  if (!isSessionEventPersistenceError(refused)) throw refused;
  expect(refused.details).toMatchObject({
    stage: "session_attempts.claim",
    retryOutcome: "not_retryable",
    sqlState: "55000",
  });
  const [state] = await shared.admin<
    { status: string; active_turn_id: string | null; attempts: number; queued: number }[]
  >`
    select s.status, s.active_turn_id,
      (select count(*)::int from session_turn_attempts a where a.session_id = s.id) as attempts,
      (select count(*)::int from session_turns t where t.session_id = s.id
        and t.status = 'queued') as queued
    from sessions s where s.id = ${f.scope.sessionId}`;
  expect(state).toMatchObject({ active_turn_id: null, attempts: 0, queued: 1 });
  expect(state!.status).not.toBe("failed");

  // A current worker then claims the same accepted work.
  const turn = await f.claim(true);
  expect(turn.activeAttemptId).toBeTruthy();

  // The claim restores the declaration: later statements in the same
  // transaction do not inherit it.
  await f.settle(turn);
  await f.prompt();
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.scope.workspaceId,
    f.subjectId,
    async (tx) => {
      expect(
        await claimSessionWorkForAttempt(tx, f.scope.workspaceId, {
          ...f.claimInput(),
          agentInstructionsProtocol: 1,
        }),
      ).toMatchObject({ action: "claimed" });
      const [stamp] = await rawRows<{ value: string }>(
        tx,
        sql`select coalesce(current_setting('opengeni.agent_instructions_protocol_v1', true), '') as value`,
      );
      expect(stamp!.value).toBe("");
    },
  );

  // Chats without an agent revision are unaffected by the gate.
  const plain = await fixture();
  await plain.prompt();
  expect(
    await claimSessionWorkForAttempt(client.db, plain.scope.workspaceId, plain.claimInput()),
  ).toMatchObject({ action: "claimed" });
}, 180_000);
