import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTargetSessionExecution,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  withWorkspaceRls,
} from "../src";

// Scheduled admission into an existing chat checks the snapshot's effective
// model against the chat's history. Before 1695 the trigger found the
// effective turn by probing each start since the last settings write against
// every turn of the session: a production chat run by a schedule every 10
// minutes (8,286 starts since its write, 1,206 turns) read 10.2M buffers and
// 3.5 s per admission. Here, with 1,500 automated turns after a write, one
// admission read 171k-197k buffers before 1695 and 1.4k (5.5k when more than
// 200 person/API turns force the walk of every start) after.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-target-admission-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const TURNS = 1500;
const BACKGROUND_SESSIONS = 6000;
// Leave room for whatever events session creation appended.
const FIRST_SEQUENCE = 1000;
// The person/API read covers at most this many person/API turns.
const PERSON_API_TURN_CAP = 200;
const BUFFER_BOUND = 5000;

type Plan = { Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } };

test("scheduled admission into a long scheduled chat reads recent history only", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Scheduled target admission",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Scheduled target admission",
    subjectId: `scheduled-admission-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const { accountId, workspaceId } = grant;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "stored-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const task = await createScheduledTask(client.db, {
    accountId,
    workspaceId,
    name: "Check this chat",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `admission-plan-${suffix}`,
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Check for updates", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    targetSessionId: session.id,
    metadata: {},
  });

  // Synthetic history from the disposable harness administrator, writer
  // triggers off: automated turns at positions 1..TURNS, each queued at
  // FIRST_SEQUENCE + position * 2 and started right after. The newest ran on
  // its own per-occurrence model.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${accountId}::uuid, ${workspaceId}::uuid,
        ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed',
        'scheduled_task', n, 'turn',
        case when n = ${TURNS} then 'newest-model' else 'older-model' end,
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()
      from generate_series(1, ${TURNS}) n`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid, turn.id,
        ${FIRST_SEQUENCE} + turn.position * 2 + step.offset_value,
        case when step.offset_value = 0 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (0), (1)) step(offset_value)
      where turn.workspace_id = ${workspaceId}::uuid and turn.session_id = ${session.id}::uuid`;
    // Production-like statistics: most sessions in a workspace are short.
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${accountId}::uuid, ${workspaceId}::uuid,
        gen_random_uuid(), gen_random_uuid(), 'background', 'completed', 'user', 1, 'turn',
        'background-model', 'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb,
        '{}'::jsonb, now(), now()
      from generate_series(1, ${BACKGROUND_SESSIONS})`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select turn.account_id, turn.workspace_id, turn.session_id, turn.id, step.offset_value,
        case when step.offset_value = 1 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (1), (2)) step(offset_value)
      where turn.workspace_id = ${workspaceId}::uuid and turn.temporal_workflow_id = 'background'`;
  });
  await shared.admin`analyze session_events`;
  await shared.admin`analyze session_turns`;

  const acceptedExecution = async () => {
    const personalResourceAuthoritySubjectId =
      await getScheduledTaskPersonalResourceAuthoritySubject(client.db, {
        accountId,
        workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
      });
    const targetSessionExecution = await getScheduledTargetSessionExecution(
      client.db,
      workspaceId,
      session.id,
      personalResourceAuthoritySubjectId,
    );
    if (!targetSessionExecution) throw new Error("scheduled target execution is unavailable");
    const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      accountId,
      workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    });
    return {
      version: 1 as const,
      task,
      resolvedModel: targetSessionExecution.model,
      resolvedReasoningEffort: targetSessionExecution.reasoningEffort,
      resolvedLatencyMode: targetSessionExecution.latencyMode,
      resolvedSandboxBackend: targetSessionExecution.sandboxBackend,
      resolvedSandboxOs: targetSessionExecution.sandboxOs,
      resolvedTools: targetSessionExecution.tools,
      resolvedFirstPartyMcpTools: targetSessionExecution.firstPartyMcpTools ?? [
        ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ],
      resolvedFirstPartyMcpPermissions: targetSessionExecution.firstPartyMcpPermissions ?? [
        ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
      ],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution,
      generatedSessionBinding: null,
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId,
      causalHumanSubjectId:
        personalResourceAuthoritySubjectId ?? causalHumanAuthority?.subjectId ?? null,
      causalHumanAuthority,
      xaiProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
      claudeProviderAccountAuthoritySnapshot: {
        version: 1 as const,
        scope: "workspace" as const,
      },
      claudeAuthoritySubjectId: null,
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service" as const, subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    };
  };
  type Accepted = Awaited<ReturnType<typeof acceptedExecution>>;

  const fire = (accepted: Accepted) =>
    createScheduledTaskRun(client.db, {
      workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
      taskExecutionDigest: task.executionDigest,
      triggerType: "scheduled",
      producerKey: `admission-plan:${crypto.randomUUID()}`,
      acceptedExecutionSnapshot: accepted,
    });

  /** Buffers of one admission as the runtime role, every nested statement included. */
  const admissionBuffers = async (accepted: Accepted) => {
    let most = 0;
    for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
      const plan = await withWorkspaceRls(client.db, workspaceId, async (tx) => {
        await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        const rows = await tx.execute(sql`explain (analyze, buffers, format json)
          select create_scheduled_agent_run_with_admission(
            ${crypto.randomUUID()}::uuid, ${accountId}::uuid, ${workspaceId}::uuid,
            ${task.id}::uuid, ${task.authorityRevision}::bigint, ${task.executionDigest}::text,
            'scheduled'::text, ${`admission-plan:${crypto.randomUUID()}`}::text,
            null::timestamptz, now(), ${JSON.stringify(accepted)}::jsonb) as id`);
        return (rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0]!.Plan;
      });
      most = Math.max(most, plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]);
    }
    return most;
  };

  const expectAdmission = async (model: string, bound = BUFFER_BOUND) => {
    const accepted = await acceptedExecution();
    // The worker's read and the admission fence agree on the effective turn.
    expect(accepted.targetSessionExecution.model).toBe(model);
    expect(await fire(accepted)).toMatchObject({ status: "queued", taskId: task.id });
    const other = {
      ...accepted,
      targetSessionExecution: { ...accepted.targetSessionExecution, model: "other-model" },
    };
    await expect(fire(other)).rejects.toMatchObject({
      cause: {
        code: "40001",
        message: "scheduled target-session execution policy changed during admission",
      },
    });
    const buffers = await admissionBuffers(accepted);
    console.log("scheduled target admission buffers", JSON.stringify({ model, buffers }));
    expect({ model, buffers: buffers < bound }).toEqual({ model, buffers: true });
    return buffers;
  };

  const addEvents = async (
    events: { turnId?: string; sequence: number; type: string }[],
    turns: { id: string; source: string; model: string; position: number }[] = [],
  ) => {
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const turn of turns) {
        await tx`
          insert into session_turns (
            id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
            status, source, position, prompt, model, reasoning_effort, latency_mode,
            sandbox_backend, resources, tools, metadata, started_at, finished_at
          ) values (${turn.id}::uuid, ${accountId}::uuid, ${workspaceId}::uuid,
            ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed',
            ${turn.source}, ${turn.position}, 'turn', ${turn.model}, 'medium', 'standard',
            'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now())`;
      }
      for (const event of events) {
        await tx`
          insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
          values (${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
            ${event.turnId ?? null}::uuid, ${event.sequence}, ${event.type}, '{}'::jsonb)`;
      }
    });
  };

  const measured: Record<string, number> = {};
  // No settings write: the newest started turn decides.
  measured.noWrite = await expectAdmission("newest-model");

  // A settings write before all of that history: automated turns cannot
  // replace the stored defaults, so no start after the write is eligible.
  // The old fence probed every one of the 1,500 starts against every turn.
  const boundary = FIRST_SEQUENCE - 10;
  await addEvents([{ sequence: boundary, type: "session.model_settings.updated" }]);
  measured.automatedOnly = await expectAdmission("stored-model");

  // A person's turn queued and started after the write, older than the newest
  // starts: found through the session's person/API turns.
  const personTurnId = crypto.randomUUID();
  await addEvents(
    [
      { turnId: personTurnId, sequence: boundary + 1, type: "turn.queued" },
      { turnId: personTurnId, sequence: boundary + 2, type: "turn.started" },
    ],
    [{ id: personTurnId, source: "user", model: "person-model", position: 0 }],
  );
  measured.personTurn = await expectAdmission("person-model");

  // More person/API turns than the person/API read covers, all queued before
  // the write: the remaining starts are walked instead, with the same answer.
  const apiTurns = Array.from({ length: PERSON_API_TURN_CAP + 1 }, (_, index) => ({
    id: crypto.randomUUID(),
    source: "api",
    model: "api-model",
    position: TURNS + 1 + index,
  }));
  await addEvents(
    apiTurns.map((turn, index) => ({
      turnId: turn.id,
      sequence: boundary - 1 - index,
      type: "turn.queued",
    })),
    apiTurns,
  );
  await shared.admin`analyze session_turns`;
  // One probe by id per start since the write, never per start and turn.
  measured.manyApiTurns = await expectAdmission("person-model", 5 * TURNS + BUFFER_BOUND);

  expect(Object.keys(measured)).toHaveLength(4);
}, 300_000);
