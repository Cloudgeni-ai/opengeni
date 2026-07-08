// packages/core/src/rigs/index.ts — the rig domain: the workspace-scoped,
// versioned sandbox-machine-definition business logic the REST routes (M2) and
// (later) the MCP rig tools (M4) both call. Validation + audit events live here;
// the raw RLS-scoped persistence lives in @opengeni/db. M4 adds verification /
// auto-merge / promotion on top of the change substrate created here.

import type {
  AccessGrant,
  CreateRigRequest,
  RigDefinitionEditPayload,
  ProposeRigChangeRequest,
  Rig,
  RigChange,
  RigVersion,
  UpdateRigRequest,
} from "@opengeni/contracts";
import {
  activateRigVersion,
  countRigs,
  countSessionsUsingRig,
  createRig,
  createRigChange,
  createRigVersion,
  deleteRig,
  getRig,
  getRigByName,
  getRigChange,
  getRigVersion,
  getVariableSet,
  listRigChanges,
  listRigVersions,
  recordAuditEvent,
  updateRigChangeStatus,
  updateRig,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export const MAX_RIGS_PER_WORKSPACE = 50;
export const MAX_CHECKS_PER_RIG = 100;
export const MAX_CREDENTIAL_HOOKS_PER_RIG = 50;
export const MAX_DEFAULT_VARIABLE_SETS_PER_RIG = 25;

export type RigServices = {
  db: Database;
};

type RigAuditAction =
  | "rig.created"
  | "rig.updated"
  | "rig.deleted"
  | "rig.change.proposed"
  | "rig.change.verified"
  | "rig.change.rejected"
  | "rig.change.failed"
  | "rig.change.merged"
  | "rig.verification.started"
  | "rig.verification.passed"
  | "rig.verification.failed"
  | "rig.version.activated"
  | "rig.version.promoted";

export async function recordRigAuditEvent(db: Database, input: {
  grant: AccessGrant;
  action: RigAuditAction;
  rigId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordAuditEvent(db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    subjectId: input.grant.subjectId,
    action: input.action,
    targetType: "rig",
    targetId: input.rigId,
    metadata: { rigId: input.rigId, ...(input.metadata ?? {}) },
  });
}

// Version attribution string for an API (user-authenticated) mutation. The MCP
// session path (M4) will use `session:<id>` instead.
export function rigActorForGrant(grant: AccessGrant): string {
  return `user:${grant.subjectId}`;
}

export async function requireRigForApi(db: Database, workspaceId: string, rigId: string): Promise<Rig> {
  const rig = await getRig(db, workspaceId, rigId);
  if (!rig) {
    throw new HTTPException(404, { message: "rig not found" });
  }
  return rig;
}

export async function requireRigChangeForApi(db: Database, workspaceId: string, rigId: string, changeId: string): Promise<RigChange> {
  const change = await getRigChange(db, workspaceId, changeId);
  // RLS + the workspace clause make a cross-workspace id indistinguishable from
  // missing; the rigId clause keeps the change addressable only under its rig.
  if (!change || change.rigId !== rigId) {
    throw new HTTPException(404, { message: "rig change not found" });
  }
  return change;
}

function trimmedRigName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HTTPException(422, { message: "rig name is required" });
  }
  return trimmed;
}

// Duplicate check names would make check results ambiguous; reject them.
function assertUniqueCheckNames(checks: ReadonlyArray<{ name: string }> | undefined): void {
  if (!checks) {
    return;
  }
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) {
      throw new HTTPException(422, { message: `duplicate rig check name: ${check.name}` });
    }
    seen.add(check.name);
  }
}

// Every referenced default variable set must exist in the workspace. RLS makes a
// cross-workspace id indistinguishable from a missing one, so both map to 422.
async function assertVariableSetsExist(db: Database, workspaceId: string, ids: ReadonlyArray<string> | undefined): Promise<void> {
  if (!ids || ids.length === 0) {
    return;
  }
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const variableSet = await getVariableSet(db, workspaceId, id);
    if (!variableSet) {
      throw new HTTPException(422, { message: `unknown defaultVariableSetId: ${id}` });
    }
  }
}

export async function createRigForApi(
  deps: RigServices,
  grant: AccessGrant,
  payload: CreateRigRequest,
): Promise<Rig> {
  const workspaceId = grant.workspaceId;
  const name = trimmedRigName(payload.name);
  assertUniqueCheckNames(payload.checks);
  await assertVariableSetsExist(deps.db, workspaceId, payload.defaultVariableSetIds);
  if (await countRigs(deps.db, workspaceId) >= MAX_RIGS_PER_WORKSPACE) {
    throw new HTTPException(422, { message: `a workspace supports at most ${MAX_RIGS_PER_WORKSPACE} rigs` });
  }
  if (await getRigByName(deps.db, workspaceId, name)) {
    throw new HTTPException(409, { message: `rig name is already in use: ${name}` });
  }
  const createdBy = rigActorForGrant(grant);
  const rig = await createRig(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    name,
    description: payload.description ?? null,
    createdBy,
    initialVersion: {
      image: payload.image ?? null,
      setupScript: payload.setupScript ?? null,
      checks: payload.checks,
      credentialHooks: payload.credentialHooks,
      defaultVariableSetIds: payload.defaultVariableSetIds,
      changelog: "Initial version",
      createdBy,
    },
  });
  await recordRigAuditEvent(deps.db, { grant, action: "rig.created", rigId: rig.id });
  return rig;
}

export async function updateRigForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  payload: UpdateRigRequest,
): Promise<Rig> {
  const workspaceId = grant.workspaceId;
  const name = payload.name !== undefined ? trimmedRigName(payload.name) : undefined;
  if (name !== undefined && name !== rig.name) {
    const existing = await getRigByName(deps.db, workspaceId, name);
    if (existing && existing.id !== rig.id) {
      throw new HTTPException(409, { message: `rig name is already in use: ${name}` });
    }
  }
  const updated = await updateRig(deps.db, workspaceId, rig.id, {
    ...(name !== undefined ? { name } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
  });
  await recordRigAuditEvent(deps.db, { grant, action: "rig.updated", rigId: rig.id });
  return updated;
}

export async function deleteRigForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
): Promise<void> {
  const workspaceId = grant.workspaceId;
  const referencingSessions = await countSessionsUsingRig(deps.db, workspaceId, rig.id);
  if (referencingSessions > 0) {
    throw new HTTPException(409, { message: `rig is referenced by ${referencingSessions} session(s); it cannot be deleted` });
  }
  await deleteRig(deps.db, workspaceId, rig.id);
  await recordRigAuditEvent(deps.db, { grant, action: "rig.deleted", rigId: rig.id });
}

// Records a proposed change against the rig's CURRENT active version (the base
// clean-replay minted new versions from). Verification / auto-merge is M4; here
// the row is created in `proposed`. `proposedBy` overrides the actor string for
// the session-scoped MCP path (M4).
export async function proposeRigChangeForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  request: ProposeRigChangeRequest,
  options: { proposedBy?: string } = {},
): Promise<RigChange> {
  const workspaceId = grant.workspaceId;
  if (!rig.activeVersion) {
    throw new HTTPException(422, { message: "rig has no active version to base a change on" });
  }
  if (request.kind === "definition_edit") {
    assertUniqueCheckNames(request.payload.checks);
    await assertVariableSetsExist(deps.db, workspaceId, request.payload.defaultVariableSetIds ?? undefined);
  }
  const change = await createRigChange(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    rigId: rig.id,
    baseVersionId: rig.activeVersion.id,
    kind: request.kind,
    payload: request.payload as Record<string, unknown>,
    proposedBy: options.proposedBy ?? rigActorForGrant(grant),
  });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.change.proposed",
    rigId: rig.id,
    metadata: { changeId: change.id, kind: change.kind },
  });
  return change;
}

export type RigVerificationClassification =
  | { status: "merged"; action: "auto_promote" }
  | { status: "proposed"; action: "await_manage_promote" }
  | { status: "rejected"; action: "reject" }
  | { status: "failed"; action: "retryable_failure" };

export function classifyRigVerificationOutcome(input: {
  kind: "setup_append" | "definition_edit";
  passed: boolean;
  infraError?: boolean;
}): RigVerificationClassification {
  if (input.infraError) {
    return { status: "failed", action: "retryable_failure" };
  }
  if (!input.passed) {
    return { status: "rejected", action: "reject" };
  }
  if (input.kind === "setup_append") {
    return { status: "merged", action: "auto_promote" };
  }
  return { status: "proposed", action: "await_manage_promote" };
}

export function appendRigSetupCommand(baseSetupScript: string | null | undefined, command: string): string {
  const base = (baseSetupScript ?? "").trimEnd();
  return base ? `${base}\n${command}` : command;
}

export async function promoteSetupAppendChange(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  change: RigChange,
): Promise<{ change: RigChange; version: RigVersion }> {
  if (change.kind !== "setup_append") {
    throw new HTTPException(422, { message: "only setup_append changes auto-promote through this path" });
  }
  if (change.status !== "proposed" && change.status !== "verifying") {
    throw new HTTPException(409, { message: `rig change is ${change.status}; cannot promote` });
  }
  if (!change.baseVersionId) {
    throw new HTTPException(422, { message: "rig change has no base version" });
  }
  const base = await getRigVersion(deps.db, grant.workspaceId, rig.id, change.baseVersionId);
  if (!base) {
    throw new HTTPException(404, { message: "base rig version not found" });
  }
  const payload = change.payload as { command?: unknown; note?: unknown };
  if (typeof payload.command !== "string" || !payload.command.trim()) {
    throw new HTTPException(422, { message: "setup_append change is missing command" });
  }
  const version = await createRigVersion(deps.db, grant.workspaceId, rig.id, {
    image: base.image,
    setupScript: appendRigSetupCommand(base.setupScript, payload.command),
    checks: base.checks,
    credentialHooks: base.credentialHooks,
    defaultVariableSetIds: base.defaultVariableSetIds,
    changelog: typeof payload.note === "string" && payload.note.trim() ? payload.note : "Verified setup append",
    createdBy: change.proposedBy ?? rigActorForGrant(grant),
  }, { activate: true });
  const updated = await updateRigChangeStatus(deps.db, grant.workspaceId, change.id, {
    status: "merged",
    resultVersionId: version.id,
  });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.change.merged",
    rigId: rig.id,
    metadata: { changeId: change.id, versionId: version.id, version: version.version },
  });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.version.promoted",
    rigId: rig.id,
    metadata: { changeId: change.id, versionId: version.id, version: version.version },
  });
  return { change: updated, version };
}

export async function promoteVerifiedDefinitionEditChangeForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  change: RigChange,
): Promise<{ change: RigChange; version: RigVersion }> {
  if (change.kind !== "definition_edit") {
    throw new HTTPException(422, { message: "only definition_edit changes use explicit promote" });
  }
  if (change.status !== "proposed") {
    throw new HTTPException(409, { message: `rig change is ${change.status}; cannot promote` });
  }
  if (change.verification?.passed !== true) {
    throw new HTTPException(422, { message: "definition_edit change must pass verification before promote" });
  }
  if (!change.baseVersionId) {
    throw new HTTPException(422, { message: "rig change has no base version" });
  }
  const base = await getRigVersion(deps.db, grant.workspaceId, rig.id, change.baseVersionId);
  if (!base) {
    throw new HTTPException(404, { message: "base rig version not found" });
  }
  const payload = change.payload as {
    image?: unknown;
    setupScript?: unknown;
    checks?: unknown;
    credentialHooks?: unknown;
    defaultVariableSetIds?: unknown;
    changelog?: unknown;
  };
  const version = await createRigVersion(deps.db, grant.workspaceId, rig.id, {
    image: payload.image === undefined ? base.image : (payload.image as string | null),
    setupScript: payload.setupScript === undefined ? base.setupScript : (payload.setupScript as string | null),
    checks: Array.isArray(payload.checks) ? payload.checks as RigVersion["checks"] : base.checks,
    credentialHooks: Array.isArray(payload.credentialHooks) ? payload.credentialHooks as string[] : base.credentialHooks,
    defaultVariableSetIds: Array.isArray(payload.defaultVariableSetIds) ? payload.defaultVariableSetIds as string[] : base.defaultVariableSetIds,
    changelog: typeof payload.changelog === "string" && payload.changelog.trim() ? payload.changelog : "Verified definition edit",
    createdBy: rigActorForGrant(grant),
  }, { activate: true });
  const updated = await updateRigChangeStatus(deps.db, grant.workspaceId, change.id, {
    status: "merged",
    resultVersionId: version.id,
  });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.change.merged",
    rigId: rig.id,
    metadata: { changeId: change.id, versionId: version.id, version: version.version },
  });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.version.promoted",
    rigId: rig.id,
    metadata: { changeId: change.id, versionId: version.id, version: version.version },
  });
  return { change: updated, version };
}

export async function createRigVersionForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  payload: RigDefinitionEditPayload,
): Promise<RigVersion> {
  if (!rig.activeVersion) {
    throw new HTTPException(422, { message: "rig has no active version" });
  }
  assertUniqueCheckNames(payload.checks);
  await assertVariableSetsExist(deps.db, grant.workspaceId, payload.defaultVariableSetIds ?? undefined);
  const base = rig.activeVersion;
  const version = await createRigVersion(deps.db, grant.workspaceId, rig.id, {
    image: payload.image === undefined ? base.image : payload.image,
    setupScript: payload.setupScript === undefined ? base.setupScript : payload.setupScript,
    checks: payload.checks ?? base.checks,
    credentialHooks: payload.credentialHooks ?? base.credentialHooks,
    defaultVariableSetIds: payload.defaultVariableSetIds ?? base.defaultVariableSetIds,
    changelog: payload.changelog ?? "Manager-created version",
    createdBy: rigActorForGrant(grant),
  }, { activate: true });
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.version.promoted",
    rigId: rig.id,
    metadata: { versionId: version.id, version: version.version, direct: true },
  });
  return version;
}

// Rollback / promote-activate: flips which existing version is active. Mints no
// new version and never touches content.
export async function activateRigVersionForApi(
  deps: RigServices,
  grant: AccessGrant,
  rig: Rig,
  versionId: string,
): Promise<RigVersion> {
  const workspaceId = grant.workspaceId;
  const version = await activateRigVersion(deps.db, workspaceId, rig.id, versionId);
  await recordRigAuditEvent(deps.db, {
    grant,
    action: "rig.version.activated",
    rigId: rig.id,
    metadata: { versionId: version.id, version: version.version },
  });
  return version;
}

// Read pass-throughs (route-facing; keep the route thin and the imports in one
// place). Versions/changes are always addressed under their rig.
export async function listRigVersionsForApi(deps: RigServices, workspaceId: string, rigId: string): Promise<RigVersion[]> {
  return await listRigVersions(deps.db, workspaceId, rigId);
}

export async function listRigChangesForApi(deps: RigServices, workspaceId: string, rigId: string, limit?: number): Promise<RigChange[]> {
  return await listRigChanges(deps.db, workspaceId, rigId, limit);
}
