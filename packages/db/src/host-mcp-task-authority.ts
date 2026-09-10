import { sql } from "drizzle-orm";
import {
  stableJson,
  ScheduledTaskRunAcceptedExecution,
  type ScheduledTask,
} from "@opengeni/contracts";
import {
  HostMcpAcceptedAuthority,
  HostMcpTaskAuthority,
  HostMcpBindingDefinition,
  HostMcpOwnerSubject,
} from "@opengeni/contracts/host-mcp-bindings";
import { getScheduledTaskRevisionAuthority } from "./scheduled-task-revision-authority";
import { getHostMcpLiveAttempt } from "./live-session-attempt";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import {
  getHostMcpBinding,
  getHostMcpDelegation,
  HostMcpDelegationAuthorityError,
  authorizeDirectHostMcpUse,
  type HostMcpBindingOwner,
} from "./host-mcp-bindings";

export type SelectedHostMcpTaskGrant = {
  delegationId: string;
  generation: number;
  bindingId: string;
  bindingGeneration: number;
  definition: HostMcpBindingDefinition;
};

/** Internal capture only. The API/core authenticates the external owner and
 * rechecks that proof in this same task-write transaction before calling. */
export async function captureHostMcpTaskAuthorities(
  db: Database,
  owner: HostMcpBindingOwner,
  task: ScheduledTask,
  selections: SelectedHostMcpTaskGrant[],
): Promise<void> {
  if (task.accountId !== owner.accountId || task.workspaceId !== owner.workspaceId)
    throw new HostMcpDelegationAuthorityError("Host task scope mismatch");
  const proof = await getScheduledTaskRevisionAuthority(db, {
    ...owner,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  if (
    !proof ||
    proof.subjectId !== owner.subjectId ||
    proof.membershipAuthorizationRevision !== owner.authorizationRevision
  )
    throw new HostMcpDelegationAuthorityError("Host task revision authority changed");
  const target =
    task.runMode === "existing_session" && task.targetSessionId
      ? ((
          await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
            rawRows<{
              id: string;
              visibility: "user_private" | "workspace_shared";
              authority_epoch: number;
            }>(
              tx,
              sql`select id, visibility, authority_epoch from sessions where id = ${task.targetSessionId}::uuid
            and workspace_id = ${owner.workspaceId}::uuid and account_id = ${owner.accountId}::uuid`,
            ),
          )
        )[0] ?? null)
      : null;
  const context = target?.visibility ?? "workspace_shared";
  await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, async (tx) => {
    for (const selection of selections) {
      const delegation = await getHostMcpDelegation(tx, owner, selection.delegationId);
      const binding = delegation ? await getHostMcpBinding(tx, owner, delegation.bindingId) : null;
      const definition = HostMcpBindingDefinition.parse(selection.definition);
      if (
        !delegation ||
        !binding ||
        delegation.status !== "active" ||
        binding.status !== "active" ||
        delegation.generation !== selection.generation ||
        binding.generation !== delegation.bindingGeneration ||
        binding.id !== selection.bindingId ||
        binding.generation !== selection.bindingGeneration ||
        stableJson(binding.definition) !== stableJson(definition) ||
        delegation.grant.context !== context ||
        (delegation.grant.mode === "session" &&
          (!target ||
            delegation.grant.sessionId !== target.id ||
            delegation.grant.expectedAuthorityEpoch !== target.authority_epoch))
      )
        throw new HostMcpDelegationAuthorityError("Host task delegation changed");
      const authority = HostMcpTaskAuthority.parse({
        version: 1,
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
        taskExecutionDigest: task.executionDigest,
        ownerSubjectId: owner.subjectId,
        ownerOrganizationMembershipId: proof.organizationMembershipId,
        ownerMembershipAuthorizationRevision: proof.membershipAuthorizationRevision,
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        delegationId: delegation.id,
        delegationGeneration: delegation.generation,
        definition,
        context,
      });
      await tx.execute(sql`insert into host_mcp_task_authorities
        (task_id, task_authority_revision, server_id, account_id, workspace_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
        values (${task.id}::uuid, ${task.authorityRevision}, ${definition.serverId}, ${owner.accountId}::uuid,
          ${owner.workspaceId}::uuid, ${owner.subjectId}, ${binding.id}::uuid, ${delegation.id}::uuid,
          ${JSON.stringify(authority)}::jsonb)`);
    }
  });
}

/** Backend-only read; native immutable task-revision proof chooses the owner.
 * No caller-supplied subject and no ambient workspace account enumeration. */
export async function getHostMcpTaskAuthorities(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    taskId: string;
    taskAuthorityRevision: number;
  },
): Promise<HostMcpTaskAuthority[]> {
  const proof = await getScheduledTaskRevisionAuthority(db, input);
  if (!proof || !HostMcpOwnerSubject.safeParse(proof.subjectId).success) return [];
  return withWorkspaceSubjectRls(db, input.workspaceId, proof.subjectId, async (tx) => {
    const rows = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`
      select canonical_snapshot from host_mcp_task_authorities where task_id = ${input.taskId}::uuid
        and task_authority_revision = ${input.taskAuthorityRevision} and account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid and owner_subject_id = ${proof.subjectId}
      order by server_id`,
    );
    return rows.map((row) => HostMcpTaskAuthority.parse(row.canonical_snapshot));
  });
}

/** Native task revisions are the authority/version boundary, including ordinary
 * lifecycle edits. Never silently drop or reassign retained host selections. */
export async function cloneHostMcpTaskAuthorities(
  db: Database,
  task: ScheduledTask,
  sourceRevision: number,
): Promise<void> {
  if (sourceRevision === task.authorityRevision) return;
  const previous = await getHostMcpTaskAuthorities(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: sourceRevision,
  });
  if (!previous.length) return;
  const existing = await getHostMcpTaskAuthorities(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  if (existing.length) {
    const selection = (a: HostMcpTaskAuthority) => ({
      definition: a.definition,
      bindingId: a.bindingId,
      bindingGeneration: a.bindingGeneration,
      delegationId: a.delegationId,
      delegationGeneration: a.delegationGeneration,
      ownerSubjectId: a.ownerSubjectId,
      ownerMembershipAuthorizationRevision: a.ownerMembershipAuthorizationRevision,
    });
    if (stableJson(existing.map(selection)) !== stableJson(previous.map(selection)))
      throw new HostMcpDelegationAuthorityError("Host task materialization selection changed");
    return;
  }
  const owner = previous[0]!;
  await captureHostMcpTaskAuthorities(
    db,
    {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: owner.ownerSubjectId,
      authorizationRevision: owner.ownerMembershipAuthorizationRevision,
    },
    task,
    previous.map((a) => ({
      delegationId: a.delegationId,
      generation: a.delegationGeneration,
      bindingId: a.bindingId,
      bindingGeneration: a.bindingGeneration,
      definition: a.definition,
    })),
  );
}

/** Claim-time attachment to the exact accepted run. No host callback or key is
 * used here; credentials are requested only when the accepted attempt uses MCP. */
export async function captureScheduledHostMcpTurnAuthorities(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    runId: string;
  },
): Promise<void> {
  const [run] = await rawRows<{
    accepted_execution_snapshot: unknown;
    task_id: string;
    task_authority_revision: string | number;
    task_execution_digest: string;
  }>(
    db,
    sql`
    select accepted_execution_snapshot, task_id, task_authority_revision, task_execution_digest from scheduled_task_runs where id = ${input.runId}::uuid
      and account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
      and session_id = ${input.sessionId}::uuid and status = 'dispatched'`,
  );
  if (!run) throw new HostMcpDelegationAuthorityError("Host scheduled run unavailable");
  const accepted = ScheduledTaskRunAcceptedExecution.parse(run.accepted_execution_snapshot);
  const authorities = await getHostMcpTaskAuthorities(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    taskId: run.task_id,
    taskAuthorityRevision: Number(run.task_authority_revision),
  });
  if (!authorities.length) return;
  const subjectId = authorities[0]!.ownerSubjectId;
  if (accepted.causalHumanSubjectId !== subjectId)
    throw new HostMcpDelegationAuthorityError("Host scheduled causal human mismatch");
  await withWorkspaceSubjectRls(db, input.workspaceId, subjectId, async (tx) => {
    const [session] = await rawRows<{ visibility: string; authority_epoch: number }>(
      tx,
      sql`
      select visibility, authority_epoch from sessions where id = ${input.sessionId}::uuid
        and account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if (!session) throw new HostMcpDelegationAuthorityError("Host scheduled session unavailable");
    for (const stored of authorities) {
      const owner = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        authorizationRevision: stored.ownerMembershipAuthorizationRevision,
      };
      const grant = await getHostMcpDelegation(tx, owner, stored.delegationId);
      const binding = await getHostMcpBinding(tx, owner, stored.bindingId);
      if (
        !grant ||
        !binding ||
        grant.status !== "active" ||
        binding.status !== "active" ||
        grant.generation !== stored.delegationGeneration ||
        binding.generation !== stored.bindingGeneration
      )
        continue;
      const { taskId, taskAuthorityRevision, taskExecutionDigest, context, ...base } = stored;
      if (taskExecutionDigest !== run.task_execution_digest || context !== session.visibility)
        throw new HostMcpDelegationAuthorityError("Host scheduled execution changed");
      const scheduledOrigin = { taskId, taskAuthorityRevision, runId: input.runId };
      const authority = HostMcpAcceptedAuthority.parse({
        ...base,
        targetSessionId: input.sessionId,
        targetSessionVisibility: session.visibility,
        targetSessionAuthorityEpoch: session.authority_epoch,
        acceptedWork: { kind: "scheduled_task", ...scheduledOrigin },
        scheduledOrigin,
        source: { kind: "scheduled_task" },
      });
      await tx.execute(sql`insert into host_mcp_turn_authorities
        (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
        values (${input.turnId}::uuid, ${stored.definition.serverId}, ${input.accountId}::uuid,
          ${input.workspaceId}::uuid, ${input.sessionId}::uuid, ${subjectId}, ${stored.bindingId}::uuid,
          ${stored.delegationId}::uuid, ${JSON.stringify(authority)}::jsonb)`);
    }
  });
}

/** Agent-created task: derive selections exclusively from its live accepted
 * attempt, then re-admit only native successor-eligible grants. No user lookup
 * or connection inventory is a fallback for a turn with no captured authority. */
export async function inheritHostMcpTaskAuthoritiesFromAttempt(
  db: Database,
  task: ScheduledTask,
  source: { sessionId: string; turnId: string; attemptId: string; executionGeneration: number },
  configured: Array<{
    bindingId: string;
    bindingGeneration: number;
    definition: HostMcpBindingDefinition;
  }>,
): Promise<void> {
  const proof = await getScheduledTaskRevisionAuthority(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  if (!proof || !HostMcpOwnerSubject.safeParse(proof.subjectId).success) return;
  const current = await getHostMcpLiveAttempt(
    db,
    task.workspaceId,
    source.sessionId,
    source.attemptId,
  );
  if (
    !current ||
    current.id !== source.turnId ||
    current.executionGeneration !== source.executionGeneration
  )
    throw new HostMcpDelegationAuthorityError("Host task source attempt changed");
  const owner = {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    subjectId: proof.subjectId,
    authorizationRevision: proof.membershipAuthorizationRevision,
  };
  const selections = await withWorkspaceSubjectRls(
    db,
    task.workspaceId,
    proof.subjectId,
    async (tx) => {
      const rows = await rawRows<{ canonical_snapshot: unknown }>(
        tx,
        sql`
      select canonical_snapshot from host_mcp_turn_authorities where account_id = ${task.accountId}::uuid
        and workspace_id = ${task.workspaceId}::uuid and session_id = ${source.sessionId}::uuid
        and turn_id = ${source.turnId}::uuid and owner_subject_id = ${proof.subjectId}`,
      );
      const selected: SelectedHostMcpTaskGrant[] = [];
      for (const row of rows) {
        const a = HostMcpAcceptedAuthority.parse(row.canonical_snapshot);
        const server = configured.find((c) => c.definition.serverId === a.definition.serverId);
        if (!server) continue;
        if (
          server.bindingId !== a.bindingId ||
          server.bindingGeneration !== a.bindingGeneration ||
          stableJson(server.definition) !== stableJson(a.definition)
        )
          throw new HostMcpDelegationAuthorityError("Host task source destination changed");
        const delegation = await getHostMcpDelegation(tx, owner, a.delegationId);
        if (
          !delegation ||
          (delegation.grant.mode === "session" &&
            (task.runMode !== "existing_session" ||
              task.targetSessionId !== delegation.grant.sessionId))
        )
          continue;
        const authorized = await authorizeDirectHostMcpUse(tx, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          sessionId: source.sessionId,
          rootSessionId: source.sessionId,
          turnId: source.turnId,
          attemptId: source.attemptId,
          executionGeneration: source.executionGeneration,
          initiator: current.initiator,
          initiatorContext: current.initiatorContext,
          surface: "model",
          serverId: a.definition.serverId,
          destinationUrl: a.definition.destinationUrl,
          credentialTarget: "mcp",
          forceRefresh: false,
          connectionRef: {
            ...a.definition.connectionRef,
            hostBinding: { bindingId: a.bindingId, generation: a.bindingGeneration },
          },
        });
        if (!authorized) continue;
        selected.push({
          delegationId: a.delegationId,
          generation: a.delegationGeneration,
          ...server,
        });
      }
      return selected;
    },
  );
  if (selections.length) await captureHostMcpTaskAuthorities(db, owner, task, selections);
}
