import { sql } from "drizzle-orm";
import { stableJson, type ScheduledTask } from "@opengeni/contracts";
import { ExternalLinkWorkSnapshot } from "@opengeni/contracts/external-identities";
import { rawRows, withWorkspaceRls, withWorkspaceSubjectRls, type Database } from "./database";
import { ensureExternalIdentity } from "./external-identities";
import { resolveExternalIdentityLink } from "./external-identity-links";
import { nestedPostgresSqlState } from "./persistence-errors";

type Scope = { accountId: string; workspaceId: string };
type Source =
  | { kind: "direct" }
  | { kind: "causal" | "child"; turnId: string }
  | { kind: "scheduled"; taskId: string; taskRevision: number };

/** Does not consult or resurrect the key used at creation. Its immutable
 * permission ceiling is already captured; membership/link revocation is live. */
export async function externalLinkWorkSnapshotIsLive(db: Database, raw: unknown): Promise<boolean> {
  const snapshot = ExternalLinkWorkSnapshot.parse(raw);
  try {
    const identity = await ensureExternalIdentity(db, {
      accountId: snapshot.actor.accountId,
      ...snapshot.identity,
    });
    if (
      identity.id !== snapshot.actor.externalIdentityId ||
      identity.subjectId !== snapshot.actor.externalSubjectId ||
      identity.authorizationRevision !== snapshot.actor.externalAuthorizationRevision
    )
      return false;
    const resolved = await resolveExternalIdentityLink(db, {
      identity,
      linkId: snapshot.actor.linkId!,
      expectedRevision: snapshot.actor.linkRevision!,
    });
    return (
      resolved !== null &&
      resolved.link.nativeSubjectId === snapshot.actor.effectiveSubjectId &&
      snapshot.permissions.every(
        (permission) =>
          resolved.link.permissions.includes(permission) ||
          (permission !== "secrets:read" && resolved.link.permissions.includes("workspace:admin")),
      )
    );
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") return false;
    throw error;
  }
}

export async function getExternalLinkTurnSnapshot(
  db: Database,
  scope: Scope,
  turnId: string,
): Promise<ExternalLinkWorkSnapshot | null> {
  return withWorkspaceRls(db, scope.workspaceId, async (tx) => {
    const [row] = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`select canonical_snapshot
      from external_link_turn_authorities where account_id = ${scope.accountId}::uuid
        and workspace_id = ${scope.workspaceId}::uuid and turn_id = ${turnId}::uuid`,
    );
    return row ? ExternalLinkWorkSnapshot.parse(row.canonical_snapshot) : null;
  });
}

/** null is an ordinary native/external turn; a revoked linked turn is false,
 * never null. Callers must not fall back to unlinked authority after denial. */
export async function getExternalLinkTurnAuthorization(db: Database, scope: Scope, turnId: string) {
  const snapshot = await getExternalLinkTurnSnapshot(db, scope, turnId);
  if (!snapshot) return null;
  return {
    authorized: await externalLinkWorkSnapshotIsLive(db, snapshot),
    permissions: snapshot.permissions,
  };
}

export async function captureExternalLinkTurnAuthority(
  db: Database,
  input: Scope & {
    sessionId: string;
    turnId: string;
    snapshot: ExternalLinkWorkSnapshot;
    source?: Source;
  },
): Promise<void> {
  const snapshot = ExternalLinkWorkSnapshot.parse(input.snapshot);
  const source = input.source ?? { kind: "direct" };
  if (snapshot.actor.accountId !== input.accountId)
    throw new Error("Linked turn organization mismatch");
  if (source.kind === "direct" && !(await externalLinkWorkSnapshotIsLive(db, snapshot)))
    throw new Error("Linked turn authority revoked");
  await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    snapshot.actor.effectiveSubjectId,
    async (tx) => {
      const existing = await getExternalLinkTurnSnapshot(tx, input, input.turnId);
      if (existing) {
        if (stableJson(existing) !== stableJson(snapshot))
          throw new Error("Linked turn replay changed authority");
        return;
      }
      await tx.execute(sql`insert into external_link_turn_authorities
      (turn_id, account_id, workspace_id, session_id, link_id, link_revision, canonical_snapshot,
        source_kind, source_turn_id, source_task_id, source_task_revision)
      values (${input.turnId}::uuid, ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${snapshot.actor.linkId}::uuid, ${snapshot.actor.linkRevision}, ${JSON.stringify(snapshot)}::jsonb, ${source.kind},
        ${source.kind === "causal" || source.kind === "child" ? source.turnId : null}::uuid,
        ${source.kind === "scheduled" ? source.taskId : null}::uuid,
        ${source.kind === "scheduled" ? source.taskRevision : null})`);
    },
  );
}

export async function inheritExternalLinkTurnAuthority(
  db: Database,
  input: Scope & {
    sessionId: string;
    turnId: string;
    sourceTurnId: string;
    kind: "causal" | "child";
  },
): Promise<void> {
  const snapshot = await getExternalLinkTurnSnapshot(db, input, input.sourceTurnId);
  if (!snapshot) return;
  // Copy even after revocation. The worker denies the copied lane; dropping it
  // would let an old linked continuation execute as an unrestricted native user.
  await captureExternalLinkTurnAuthority(db, {
    ...input,
    snapshot,
    source: { kind: input.kind, turnId: input.sourceTurnId },
  });
}

export async function getExternalLinkTaskSnapshot(
  db: Database,
  input: Scope & {
    taskId: string;
    taskRevision: number;
  },
): Promise<ExternalLinkWorkSnapshot | null> {
  return withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`select canonical_snapshot
      from external_link_task_authorities where account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid and task_revision = ${input.taskRevision}`,
    );
    return row ? ExternalLinkWorkSnapshot.parse(row.canonical_snapshot) : null;
  });
}

export async function captureExternalLinkTaskAuthority(
  db: Database,
  task: ScheduledTask,
  raw: ExternalLinkWorkSnapshot,
): Promise<void> {
  const snapshot = ExternalLinkWorkSnapshot.parse(raw);
  if (task.accountId !== snapshot.actor.accountId)
    throw new Error("Linked task organization mismatch");
  await withWorkspaceSubjectRls(
    db,
    task.workspaceId,
    snapshot.actor.effectiveSubjectId,
    async (tx) => {
      const existing = await getExternalLinkTaskSnapshot(tx, {
        ...task,
        taskId: task.id,
        taskRevision: task.authorityRevision,
      });
      if (existing) {
        if (stableJson(existing) !== stableJson(snapshot))
          throw new Error("Linked task replay changed authority");
        return;
      }
      await tx.execute(sql`insert into external_link_task_authorities
      (task_id, task_revision, account_id, workspace_id, link_id, link_revision, canonical_snapshot)
      values (${task.id}::uuid, ${task.authorityRevision}, ${task.accountId}::uuid, ${task.workspaceId}::uuid,
        ${snapshot.actor.linkId}::uuid, ${snapshot.actor.linkRevision}, ${JSON.stringify(snapshot)}::jsonb)`);
    },
  );
}

export async function cloneExternalLinkTaskAuthority(
  db: Database,
  task: ScheduledTask,
  sourceRevision: number,
): Promise<void> {
  if (task.authorityRevision === sourceRevision) return;
  const snapshot = await getExternalLinkTaskSnapshot(db, {
    ...task,
    taskId: task.id,
    taskRevision: sourceRevision,
  });
  if (snapshot) await captureExternalLinkTaskAuthority(db, task, snapshot);
}

export async function captureScheduledExternalLinkTurnAuthority(
  db: Database,
  input: Scope & {
    sessionId: string;
    turnId: string;
    runId: string;
  },
): Promise<void> {
  const run = await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{ task_id: string; task_authority_revision: number | string }>(
      tx,
      sql`select task_id, task_authority_revision from scheduled_task_runs
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          and session_id = ${input.sessionId}::uuid and id = ${input.runId}::uuid`,
    );
    return row;
  });
  if (!run) throw new Error("Linked schedule run unavailable");
  const taskRevision = Number(run.task_authority_revision);
  const snapshot = await getExternalLinkTaskSnapshot(db, {
    ...input,
    taskId: run.task_id,
    taskRevision,
  });
  if (snapshot)
    await captureExternalLinkTurnAuthority(db, {
      ...input,
      snapshot,
      source: { kind: "scheduled", taskId: run.task_id, taskRevision },
    });
}
