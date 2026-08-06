import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { setSubjectRlsContext, withWorkspaceRls } from "./database";
import {
  hashMemoryOperationPlan,
  hashMemoryRevertPlan,
  normalizeMemoryOperationPlan,
  normalizeMemoryRevertPlan,
  normalizeMemoryRoleKey,
  type MemoryOperationPlanInput,
  type MemoryRevertPlanInput,
} from "./memory-domain";

export class MemoryGovernanceAuthorityError extends Error {
  readonly name = "MemoryGovernanceAuthorityError";
}

export type MemoryGovernanceDirectSubjectAuthority = {
  kind: "subject";
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

export type MemoryGovernanceDirectServiceAuthority = {
  kind: "service";
  accountId: string;
  workspaceId: string;
  serviceId: string;
};

export type MemoryGovernanceAttemptAuthority = {
  kind: "attempt";
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type MemoryGovernanceAuthority =
  | MemoryGovernanceDirectSubjectAuthority
  | MemoryGovernanceDirectServiceAuthority
  | MemoryGovernanceAttemptAuthority;

type ResolvedMemoryGovernanceAuthority = {
  accountId: string;
  workspaceId: string;
  actorKind: "subject" | "service";
  actorSubjectId: string;
  sessionId: string | null;
  turnId: string | null;
  attemptId: string | null;
  executionGeneration: number | null;
  roleKey: string | null;
};

function requireBoundedActorId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024) {
    throw new MemoryGovernanceAuthorityError(`${label} must be a non-empty bounded identifier`);
  }
  return normalized;
}

async function setAndVerifyMemoryGovernanceContext(
  db: Database,
  authority: ResolvedMemoryGovernanceAuthority,
): Promise<void> {
  if (authority.actorKind === "subject") {
    await setSubjectRlsContext(db, authority.actorSubjectId);
  } else {
    await db.execute(sql`select set_config('opengeni.subject_id', '', true)`);
  }
  await db.execute(sql`
    select
      set_config('opengeni.memory_actor_kind', ${authority.actorKind}, true),
      set_config('opengeni.memory_actor_id', ${authority.actorSubjectId}, true),
      set_config('opengeni.memory_session_id', ${authority.sessionId ?? ""}, true),
      set_config('opengeni.memory_role_key', ${authority.roleKey ?? ""}, true)
  `);
  const rows = (await db.execute(sql`
    select
      nullif(current_setting('opengeni.account_id', true), '') as account_id,
      nullif(current_setting('opengeni.workspace_id', true), '') as workspace_id,
      nullif(current_setting('opengeni.subject_id', true), '') as subject_id,
      nullif(current_setting('opengeni.memory_actor_kind', true), '') as actor_kind,
      nullif(current_setting('opengeni.memory_actor_id', true), '') as actor_id,
      nullif(current_setting('opengeni.memory_session_id', true), '') as session_id,
      nullif(current_setting('opengeni.memory_role_key', true), '') as role_key
  `)) as unknown as Array<{
    account_id: string | null;
    workspace_id: string | null;
    subject_id: string | null;
    actor_kind: string | null;
    actor_id: string | null;
    session_id: string | null;
    role_key: string | null;
  }>;
  const applied = rows[0];
  if (
    !applied ||
    applied.account_id !== authority.accountId ||
    applied.workspace_id !== authority.workspaceId ||
    applied.subject_id !== (authority.actorKind === "subject" ? authority.actorSubjectId : null) ||
    applied.actor_kind !== authority.actorKind ||
    applied.actor_id !== authority.actorSubjectId ||
    applied.session_id !== authority.sessionId ||
    applied.role_key !== authority.roleKey
  ) {
    throw new MemoryGovernanceAuthorityError(
      "Memory governance authority was not applied on the active database backend",
    );
  }
}

async function resolveAttemptAuthority(
  db: Database,
  input: MemoryGovernanceAttemptAuthority,
): Promise<ResolvedMemoryGovernanceAuthority> {
  if (!Number.isSafeInteger(input.executionGeneration) || input.executionGeneration <= 0) {
    throw new MemoryGovernanceAuthorityError(
      "Memory governance attempt requires a positive execution generation",
    );
  }
  const rows = (await db.execute(sql`
    with locked_workspace as materialized (
      select workspace.id, workspace.account_id
      from workspaces workspace
      where workspace.id = ${input.workspaceId}::uuid
        and workspace.account_id = ${input.accountId}::uuid
      for key share of workspace
    ), locked_session as materialized (
      select session.id, session.account_id, session.workspace_id,
        session.active_turn_id, session.metadata ->> 'memoryRoleKey' as memory_role_key
      from sessions session
      join locked_workspace workspace
        on workspace.id = session.workspace_id
       and workspace.account_id = session.account_id
      where session.id = ${input.sessionId}::uuid
        and session.active_turn_id = ${input.turnId}::uuid
      for share of session
    ), locked_turn as materialized (
      select turn.id, turn.account_id, turn.workspace_id, turn.session_id,
        turn.active_attempt_id, turn.execution_generation,
        turn.initiator_kind, turn.initiator_subject_id
      from session_turns turn
      join locked_session session
        on session.id = turn.session_id
       and session.workspace_id = turn.workspace_id
       and session.account_id = turn.account_id
      where turn.id = ${input.turnId}::uuid
        and turn.active_attempt_id = ${input.attemptId}::uuid
        and turn.execution_generation = ${input.executionGeneration}
        and turn.status in ('running', 'requires_action', 'recovering', 'waiting_capacity')
        and turn.initiator_kind in ('subject', 'service')
        and length(btrim(turn.initiator_subject_id)) between 1 and 1024
      for share of turn
    ), locked_attempt as materialized (
      select attempt.id, attempt.account_id, attempt.workspace_id,
        attempt.session_id, attempt.turn_id, attempt.execution_generation
      from session_turn_attempts attempt
      join locked_turn turn
        on turn.id = attempt.turn_id
       and turn.session_id = attempt.session_id
       and turn.workspace_id = attempt.workspace_id
       and turn.account_id = attempt.account_id
      where attempt.id = ${input.attemptId}::uuid
        and attempt.execution_generation = ${input.executionGeneration}
        and attempt.state in ('claimed', 'running')
        and not exists (
          select 1
          from session_attempt_interruptions interruption
          where interruption.workspace_id = attempt.workspace_id
            and interruption.attempt_id = attempt.id
            and interruption.state in ('pending', 'delivered', 'acknowledged')
        )
      for share of attempt
    )
    select turn.initiator_kind, turn.initiator_subject_id, session.memory_role_key
    from locked_workspace workspace
    join locked_session session on true
    join locked_turn turn on true
    join locked_attempt attempt on true
    where workspace.account_id = attempt.account_id
      and workspace.id = attempt.workspace_id
      and session.id = attempt.session_id
      and turn.id = attempt.turn_id
  `)) as unknown as Array<{
    initiator_kind: "subject" | "service";
    initiator_subject_id: string;
    memory_role_key: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    throw new MemoryGovernanceAuthorityError(
      "Memory governance requires the exact current attempt, generation, and immutable initiator",
    );
  }
  let roleKey: string | null = null;
  if (row.memory_role_key !== null) {
    try {
      roleKey = normalizeMemoryRoleKey(row.memory_role_key);
    } catch {
      throw new MemoryGovernanceAuthorityError(
        "Persisted session memoryRoleKey is invalid; role-scoped authority fails closed",
      );
    }
    if (roleKey !== row.memory_role_key) {
      throw new MemoryGovernanceAuthorityError(
        "Persisted session memoryRoleKey is not canonical; role-scoped authority fails closed",
      );
    }
  }
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actorKind: row.initiator_kind,
    actorSubjectId: row.initiator_subject_id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration,
    roleKey,
  };
}

async function withMemoryGovernanceAuthority<T>(
  db: Database,
  authority: MemoryGovernanceAuthority,
  fn: (db: Database, authority: ResolvedMemoryGovernanceAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceRls(db, authority.workspaceId, async (scopedDb) => {
    let resolved: ResolvedMemoryGovernanceAuthority;
    if (authority.kind === "attempt") {
      resolved = await resolveAttemptAuthority(scopedDb, authority);
    } else {
      const actorSubjectId = requireBoundedActorId(
        authority.kind === "subject" ? authority.subjectId : authority.serviceId,
        authority.kind === "subject" ? "subject id" : "service id",
      );
      resolved = {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        actorKind: authority.kind,
        actorSubjectId,
        sessionId: null,
        turnId: null,
        attemptId: null,
        executionGeneration: null,
        roleKey: null,
      };
    }
    await setAndVerifyMemoryGovernanceContext(scopedDb, resolved);
    return await fn(scopedDb, resolved);
  });
}

export async function applyKnowledgeMemoryOperation(
  db: Database,
  input: {
    authority: MemoryGovernanceAuthority;
    plan: MemoryOperationPlanInput;
  },
): Promise<{ eventId: string; planHash: string }> {
  const plan = normalizeMemoryOperationPlan(input.plan);
  const planHash = hashMemoryOperationPlan(plan);
  return await withMemoryGovernanceAuthority(db, input.authority, async (scopedDb, authority) => {
    const rows = (await scopedDb.execute(sql`
      select event_id
      from knowledge_memory_apply_operation(
        ${JSON.stringify(plan)}::jsonb,
        ${planHash},
        ${authority.actorKind},
        ${authority.actorSubjectId},
        ${authority.sessionId}::uuid,
        ${authority.turnId}::uuid,
        ${authority.attemptId}::uuid,
        ${authority.executionGeneration}::integer
      )
    `)) as unknown as Array<{ event_id: string }>;
    const eventId = rows[0]?.event_id;
    if (!eventId) throw new Error("Memory governance apply operation returned no event");
    return { eventId, planHash };
  });
}

export async function revertKnowledgeMemoryOperation(
  db: Database,
  input: {
    authority: MemoryGovernanceAuthority;
    plan: MemoryRevertPlanInput;
  },
): Promise<{ eventId: string; planHash: string }> {
  const plan = normalizeMemoryRevertPlan(input.plan);
  const planHash = hashMemoryRevertPlan(plan);
  return await withMemoryGovernanceAuthority(db, input.authority, async (scopedDb, authority) => {
    const rows = (await scopedDb.execute(sql`
      select event_id
      from knowledge_memory_revert_operation(
        ${plan.operationId}::uuid,
        ${plan.appliedOperationId}::uuid,
        ${planHash},
        ${authority.actorKind},
        ${authority.actorSubjectId},
        ${authority.sessionId}::uuid,
        ${authority.turnId}::uuid,
        ${authority.attemptId}::uuid,
        ${authority.executionGeneration}::integer
      )
    `)) as unknown as Array<{ event_id: string }>;
    const eventId = rows[0]?.event_id;
    if (!eventId) throw new Error("Memory governance revert operation returned no event");
    return { eventId, planHash };
  });
}
