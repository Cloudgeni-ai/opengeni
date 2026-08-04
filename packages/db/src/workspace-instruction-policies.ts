import { createHash, randomUUID } from "node:crypto";
import {
  PreferenceRegistrySnapshot,
  ResolvedWorkspaceInstructionPolicySnapshot,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  WorkspaceInstructionPolicySnapshot,
} from "@opengeni/contracts";
import type {
  WorkspaceInstructionPolicyActivationEvent,
  WorkspaceInstructionPolicyActivationResponse,
  WorkspaceInstructionPolicyActivationType,
  WorkspaceInstructionPolicyDiffResponse,
  WorkspaceInstructionPolicyDraftProvenanceSource,
  WorkspaceInstructionPolicyHead,
  WorkspaceInstructionPolicyKind,
  WorkspaceInstructionPolicyListQuery,
  WorkspaceInstructionPolicyListResponse,
  WorkspaceInstructionPolicyOnboardingProposal,
  WorkspaceInstructionPolicyOnboardingProposalListQuery,
  WorkspaceInstructionPolicyOnboardingProposalListResponse,
  WorkspaceInstructionPolicyProvenanceSource,
  WorkspaceInstructionPolicyRevision,
  WorkspaceInstructionPolicyScope,
  WorkspaceInstructionPolicySnapshotEntry,
  WorkspaceInstructionPolicyTarget,
} from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext, withWorkspaceRls, withWorkspaceSubjectRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

type DraftRequestInput = WorkspaceInstructionPolicyTarget & {
  operationId: string;
  accountId: string;
  workspaceId: string;
  content: string;
  provenanceSource: WorkspaceInstructionPolicyProvenanceSource;
  provenanceSourceId: string | null;
  supersedesRevisionId: string | null;
  createdBySubjectId: string;
};

type DraftInput = DraftRequestInput & {
  requestFingerprint: string;
};

type CallerDraftInput = Omit<DraftRequestInput, "operationId" | "provenanceSource"> & {
  operationId?: string;
  provenanceSource: WorkspaceInstructionPolicyDraftProvenanceSource;
};

type ImportLegacyRequestInput = {
  operationId: string;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  supersedesRevisionId: string | null;
};

type ActiveRevisionInput = {
  operationId: string;
  accountId: string;
  workspaceId: string;
  targetRevisionId: string;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion?: number;
  actorSubjectId: string;
  reason: string;
  type: WorkspaceInstructionPolicyActivationType;
};

type OnboardingProposalRequestInput = WorkspaceInstructionPolicyTarget & {
  operationId: string;
  accountId: string;
  workspaceId: string;
  content: string;
  sourceId: string;
  sourceVersion: string;
  confidenceBps: number;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion: number;
  createdBySubjectId: string;
};

type OnboardingProposalInput = OnboardingProposalRequestInput & {
  requestFingerprint: string;
};

export class WorkspaceInstructionPolicyConflictError extends Error {
  readonly name = "WorkspaceInstructionPolicyConflictError";
  readonly code = "WORKSPACE_INSTRUCTION_POLICY_CONFLICT";

  constructor(readonly currentHead: WorkspaceInstructionPolicyHead | null) {
    super("The active workspace instruction policy changed in another request");
  }
}

export class WorkspaceInstructionPolicyOperationReuseError extends Error {
  readonly name = "WorkspaceInstructionPolicyOperationReuseError";
  readonly code = "WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED";

  constructor() {
    super("The workspace instruction-policy operation id was already used for another request");
  }
}

export class WorkspaceInstructionPolicyNotFoundError extends Error {
  readonly name = "WorkspaceInstructionPolicyNotFoundError";

  constructor(message = "Workspace instruction-policy revision was not found") {
    super(message);
  }
}

export class WorkspaceInstructionPolicyInvalidOperationError extends Error {
  readonly name = "WorkspaceInstructionPolicyInvalidOperationError";
}

export class WorkspaceInstructionPolicyLegacyUnavailableError extends Error {
  readonly name = "WorkspaceInstructionPolicyLegacyUnavailableError";

  constructor() {
    super("This workspace has no legacy agent instructions to import");
  }
}

export class WorkspaceInstructionPolicyOnboardingProposalContentError extends Error {
  readonly name = "WorkspaceInstructionPolicyOnboardingProposalContentError";

  constructor(
    readonly code:
      | "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY"
      | "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED",
  ) {
    super(
      code === "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY"
        ? "An onboarding proposal must contain non-blank instruction-policy content"
        : `An onboarding proposal must not exceed ${WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters`,
    );
  }
}

export class WorkspaceInstructionPolicyOnboardingProposalStaleError extends Error {
  readonly name = "WorkspaceInstructionPolicyOnboardingProposalStaleError";
  readonly code = "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE";

  constructor(readonly currentHead: WorkspaceInstructionPolicyHead | null) {
    super("The onboarding proposal was prepared against a stale active policy baseline");
  }
}

export class WorkspaceInstructionPolicyOnboardingProposalConflictError extends Error {
  readonly name = "WorkspaceInstructionPolicyOnboardingProposalConflictError";
  readonly code = "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT";

  constructor(
    readonly existingProposalId: string,
    readonly existingDraftRevisionId: string,
  ) {
    super("This onboarding source version already proposed a draft for the policy target");
  }
}

export class WorkspaceInstructionPolicySnapshotAuthorityError extends Error {
  readonly name = "WorkspaceInstructionPolicySnapshotAuthorityError";
}

export type WorkspaceInstructionPolicyAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type WorkspaceStateAcceptedAttemptGovernance = {
  attemptId: string;
  executionGeneration: number;
  acceptedAt: string;
  policySnapshot: WorkspaceInstructionPolicySnapshot | null;
  preferenceSnapshot: {
    id: string;
    descriptorHash: string;
    descriptors: Array<{
      id: string;
      revisionId: string;
      contentHash: string;
      activeVersion: number;
      scope: "organization" | "workspace" | "user";
    }>;
    truncated: boolean;
    createdAt: string;
  } | null;
};

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

type OperationFingerprintField = readonly [
  name: string,
  present: boolean,
  value: string | number | null,
];

function hasOwnField(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function operationRequestFingerprint(
  operation: string,
  fields: readonly OperationFingerprintField[],
): string {
  const canonicalRequest = JSON.stringify([
    "workspace_instruction_policy_operation",
    1,
    operation,
    fields,
  ]);
  return createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
}

function draftRequestFingerprint(input: DraftRequestInput): string {
  return operationRequestFingerprint("create_draft", [
    ["accountId", true, input.accountId],
    ["workspaceId", true, input.workspaceId],
    ["kind", true, input.kind],
    ["scope", true, input.scope],
    ["roleKey", true, input.roleKey],
    ["content", true, input.content],
    ["provenanceSource", true, input.provenanceSource],
    ["provenanceSourceId", true, input.provenanceSourceId],
    ["supersedesRevisionId", true, input.supersedesRevisionId],
    ["createdBySubjectId", true, input.createdBySubjectId],
  ]);
}

function importLegacyRequestFingerprint(input: ImportLegacyRequestInput): string {
  return operationRequestFingerprint("import_legacy", [
    ["accountId", true, input.accountId],
    ["workspaceId", true, input.workspaceId],
    ["createdBySubjectId", true, input.createdBySubjectId],
    ["supersedesRevisionId", true, input.supersedesRevisionId],
  ]);
}

function activeRevisionRequestFingerprint(input: ActiveRevisionInput): string {
  const expectedCurrentRevisionIdPresent = hasOwnField(input, "expectedCurrentRevisionId");
  const expectedActivationVersionPresent = hasOwnField(input, "expectedActivationVersion");
  return operationRequestFingerprint(`change_active_revision:${input.type}`, [
    ["accountId", true, input.accountId],
    ["workspaceId", true, input.workspaceId],
    ["targetRevisionId", true, input.targetRevisionId],
    [
      "expectedCurrentRevisionId",
      expectedCurrentRevisionIdPresent,
      input.expectedCurrentRevisionId ?? null,
    ],
    [
      "expectedActivationVersion",
      expectedActivationVersionPresent,
      input.expectedActivationVersion ?? null,
    ],
    ["actorSubjectId", true, input.actorSubjectId],
    ["reason", true, input.reason],
  ]);
}

function onboardingProposalRequestFingerprint(input: OnboardingProposalRequestInput): string {
  return operationRequestFingerprint("create_onboarding_proposal", [
    ["accountId", true, input.accountId],
    ["workspaceId", true, input.workspaceId],
    ["kind", true, input.kind],
    ["scope", true, input.scope],
    ["roleKey", true, input.roleKey],
    ["content", true, input.content],
    ["sourceId", true, input.sourceId],
    ["sourceVersion", true, input.sourceVersion],
    ["confidenceBps", true, input.confidenceBps],
    ["expectedCurrentRevisionId", true, input.expectedCurrentRevisionId],
    ["expectedActivationVersion", true, input.expectedActivationVersion],
    ["createdBySubjectId", true, input.createdBySubjectId],
  ]);
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Inspect one immutable accepted attempt only when the authenticated caller is
 * exactly its frozen initiating human. The null result deliberately conflates
 * absence, cross-account/workspace lookup, and another subject's attempt.
 */
export async function getWorkspaceStateAcceptedAttemptGovernance(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; attemptId: string },
): Promise<WorkspaceStateAcceptedAttemptGovernance | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const initiatingSubject = sql<string>`coalesce(
        ${schema.sessionTurns.initiatingHumanSubjectId},
        case when ${schema.sessionTurns.initiatorKind} = 'subject'
          then ${schema.sessionTurns.initiatorSubjectId}
        end
      )`;
    const [attempt] = await scopedDb
      .select({
        attemptId: schema.sessionTurnAttempts.id,
        executionGeneration: schema.sessionTurnAttempts.executionGeneration,
        acceptedAt: schema.sessionTurns.createdAt,
      })
      .from(schema.sessionTurnAttempts)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.accountId, schema.sessionTurnAttempts.accountId),
          eq(schema.sessionTurns.workspaceId, schema.sessionTurnAttempts.workspaceId),
          eq(schema.sessionTurns.sessionId, schema.sessionTurnAttempts.sessionId),
          eq(schema.sessionTurns.id, schema.sessionTurnAttempts.turnId),
        ),
      )
      .where(
        and(
          eq(schema.sessionTurnAttempts.accountId, input.accountId),
          eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
          eq(schema.sessionTurnAttempts.id, input.attemptId),
          eq(initiatingSubject, input.subjectId),
        ),
      )
      .limit(1);
    if (!attempt) return null;

    const [policyRows, preferenceRows] = await Promise.all([
      scopedDb
        .select()
        .from(schema.workspaceInstructionPolicySnapshots)
        .where(
          and(
            eq(schema.workspaceInstructionPolicySnapshots.accountId, input.accountId),
            eq(schema.workspaceInstructionPolicySnapshots.workspaceId, input.workspaceId),
            eq(schema.workspaceInstructionPolicySnapshots.attemptId, input.attemptId),
            eq(
              schema.workspaceInstructionPolicySnapshots.executionGeneration,
              attempt.executionGeneration,
            ),
          ),
        )
        .limit(1),
      scopedDb
        .select()
        .from(schema.preferenceRegistrySnapshots)
        .where(
          and(
            eq(schema.preferenceRegistrySnapshots.accountId, input.accountId),
            eq(schema.preferenceRegistrySnapshots.workspaceId, input.workspaceId),
            eq(schema.preferenceRegistrySnapshots.attemptId, input.attemptId),
            eq(schema.preferenceRegistrySnapshots.executionGeneration, attempt.executionGeneration),
            eq(schema.preferenceRegistrySnapshots.initiatingHumanSubjectId, input.subjectId),
          ),
        )
        .limit(1),
    ]);
    const policyRow = policyRows[0] ?? null;
    const preferenceRow = preferenceRows[0] ?? null;
    return {
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      acceptedAt: iso(attempt.acceptedAt),
      policySnapshot: policyRow
        ? WorkspaceInstructionPolicySnapshot.parse({
            id: policyRow.id,
            workspaceId: policyRow.workspaceId,
            sessionId: policyRow.sessionId,
            turnId: policyRow.turnId,
            attemptId: policyRow.attemptId,
            executionGeneration: policyRow.executionGeneration,
            policyRole: policyRow.policyRole,
            roleSource: policyRow.roleSource,
            entries: policyRow.entries,
            entryHash: policyRow.entryHash,
            createdAt: iso(policyRow.createdAt),
          })
        : null,
      preferenceSnapshot: preferenceRow
        ? (() => {
            const snapshot = PreferenceRegistrySnapshot.parse({
              id: preferenceRow.id,
              workspaceId: preferenceRow.workspaceId,
              sessionId: preferenceRow.sessionId,
              turnId: preferenceRow.turnId,
              attemptId: preferenceRow.attemptId,
              executionGeneration: preferenceRow.executionGeneration,
              initiatingHumanSubjectId: preferenceRow.initiatingHumanSubjectId,
              descriptorHash: preferenceRow.descriptorHash,
              descriptors: preferenceRow.descriptors,
              truncated: preferenceRow.truncated,
              createdAt: iso(preferenceRow.createdAt),
            });
            return {
              id: snapshot.id,
              descriptorHash: snapshot.descriptorHash,
              descriptors: snapshot.descriptors.map((descriptor) => ({
                id: descriptor.id,
                revisionId: descriptor.revisionId,
                contentHash: descriptor.contentHash,
                activeVersion: descriptor.activeVersion,
                scope: descriptor.scope,
              })),
              truncated: snapshot.truncated,
              createdAt: snapshot.createdAt,
            };
          })()
        : null,
    };
  });
}

type RevisionRow = typeof schema.workspaceInstructionPolicyRevisions.$inferSelect;
type HeadRow = typeof schema.workspaceInstructionPolicyHeads.$inferSelect;
type EventRow = typeof schema.workspaceInstructionPolicyActivationEvents.$inferSelect;
type OnboardingProposalRow =
  typeof schema.workspaceInstructionPolicyOnboardingProposals.$inferSelect;

function revisionFromRow(row: RevisionRow): WorkspaceInstructionPolicyRevision {
  return {
    id: row.id,
    operationId: row.operationId ?? row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    kind: row.kind as WorkspaceInstructionPolicyKind,
    scope: row.scope as WorkspaceInstructionPolicyScope,
    roleKey: row.roleKey,
    content: row.content,
    contentHash: row.contentHash,
    provenance: {
      source: row.provenanceSource as WorkspaceInstructionPolicyProvenanceSource,
      sourceId: row.provenanceSourceId,
    },
    supersedesRevisionId: row.supersedesRevisionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function headFromRow(row: HeadRow): WorkspaceInstructionPolicyHead {
  return {
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceInstructionPolicyKind,
    scope: row.scope as WorkspaceInstructionPolicyScope,
    roleKey: row.roleKey,
    revisionId: row.revisionId,
    revision: row.revision,
    contentHash: row.contentHash,
    activationVersion: row.activationVersion,
    activatedAt: iso(row.activatedAt),
  };
}

function eventFromRow(row: EventRow): WorkspaceInstructionPolicyActivationEvent {
  return {
    id: row.id,
    operationId: row.operationId ?? row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceInstructionPolicyKind,
    scope: row.scope as WorkspaceInstructionPolicyScope,
    roleKey: row.roleKey,
    type: row.type as WorkspaceInstructionPolicyActivationType,
    activationVersion: row.activationVersion,
    oldRevision:
      row.oldRevisionId === null
        ? null
        : {
            id: row.oldRevisionId,
            revision: row.oldRevision!,
            contentHash: row.oldContentHash!,
          },
    newRevision: {
      id: row.newRevisionId,
      revision: row.newRevision,
      contentHash: row.newContentHash,
    },
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

function onboardingProposalFromRow(
  row: OnboardingProposalRow,
  draftRow: RevisionRow,
): WorkspaceInstructionPolicyOnboardingProposal {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceInstructionPolicyKind,
    scope: row.scope as WorkspaceInstructionPolicyScope,
    roleKey: row.roleKey,
    source: {
      id: row.sourceId,
      version: row.sourceVersion,
      confidenceBps: row.confidenceBps,
    },
    baseline:
      row.baselineRevisionId === null
        ? null
        : {
            workspaceId: row.workspaceId,
            kind: row.kind as WorkspaceInstructionPolicyKind,
            scope: row.scope as WorkspaceInstructionPolicyScope,
            roleKey: row.roleKey,
            revisionId: row.baselineRevisionId,
            revision: row.baselineRevision!,
            contentHash: row.baselineContentHash!,
            activationVersion: row.baselineActivationVersion,
            activatedAt: iso(row.baselineActivatedAt!),
          },
    draft: revisionFromRow(draftRow),
    status: "proposed",
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function headFromEventRow(row: EventRow): WorkspaceInstructionPolicyHead {
  return {
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceInstructionPolicyKind,
    scope: row.scope as WorkspaceInstructionPolicyScope,
    roleKey: row.roleKey,
    revisionId: row.newRevisionId,
    revision: row.newRevision,
    contentHash: row.newContentHash,
    activationVersion: row.activationVersion,
    activatedAt: iso(row.createdAt),
  };
}

function headTargetConditions(
  workspaceId: string,
  target: WorkspaceInstructionPolicyTarget,
): SQL[] {
  return [
    eq(schema.workspaceInstructionPolicyHeads.workspaceId, workspaceId),
    eq(schema.workspaceInstructionPolicyHeads.kind, target.kind),
    eq(schema.workspaceInstructionPolicyHeads.scope, target.scope),
    target.roleKey === null
      ? isNull(schema.workspaceInstructionPolicyHeads.roleKey)
      : eq(schema.workspaceInstructionPolicyHeads.roleKey, target.roleKey),
  ];
}

function eventTargetConditions(
  workspaceId: string,
  target: WorkspaceInstructionPolicyTarget,
): SQL[] {
  return [
    eq(schema.workspaceInstructionPolicyActivationEvents.workspaceId, workspaceId),
    eq(schema.workspaceInstructionPolicyActivationEvents.kind, target.kind),
    eq(schema.workspaceInstructionPolicyActivationEvents.scope, target.scope),
    target.roleKey === null
      ? isNull(schema.workspaceInstructionPolicyActivationEvents.roleKey)
      : eq(schema.workspaceInstructionPolicyActivationEvents.roleKey, target.roleKey),
  ];
}

async function lockWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<{ agentInstructions: string | null }> {
  const [workspace] = await db
    .select({ agentInstructions: schema.workspaces.agentInstructions })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, input.workspaceId),
        eq(schema.workspaces.accountId, input.accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!workspace) {
    throw new WorkspaceInstructionPolicyNotFoundError("Workspace was not found");
  }
  return workspace;
}

async function getRevisionInTransaction(
  db: Database,
  workspaceId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyRevisions)
    .where(
      and(
        eq(schema.workspaceInstructionPolicyRevisions.workspaceId, workspaceId),
        eq(schema.workspaceInstructionPolicyRevisions.id, revisionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getRevisionByOperationInTransaction(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<RevisionRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyRevisions)
    .where(
      and(
        eq(schema.workspaceInstructionPolicyRevisions.workspaceId, workspaceId),
        or(
          eq(schema.workspaceInstructionPolicyRevisions.operationId, operationId),
          and(
            isNull(schema.workspaceInstructionPolicyRevisions.operationId),
            eq(schema.workspaceInstructionPolicyRevisions.id, operationId),
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getEventByOperationInTransaction(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<EventRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyActivationEvents)
    .where(
      and(
        eq(schema.workspaceInstructionPolicyActivationEvents.workspaceId, workspaceId),
        or(
          eq(schema.workspaceInstructionPolicyActivationEvents.operationId, operationId),
          and(
            isNull(schema.workspaceInstructionPolicyActivationEvents.operationId),
            eq(schema.workspaceInstructionPolicyActivationEvents.id, operationId),
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getOnboardingProposalByOperationInTransaction(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<OnboardingProposalRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyOnboardingProposals)
    .where(
      and(
        eq(schema.workspaceInstructionPolicyOnboardingProposals.workspaceId, workspaceId),
        eq(schema.workspaceInstructionPolicyOnboardingProposals.operationId, operationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getOnboardingProposalBySourceVersionInTransaction(
  db: Database,
  input: Pick<
    OnboardingProposalRequestInput,
    "workspaceId" | "kind" | "scope" | "roleKey" | "sourceId" | "sourceVersion"
  >,
): Promise<OnboardingProposalRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyOnboardingProposals)
    .where(
      and(
        eq(schema.workspaceInstructionPolicyOnboardingProposals.workspaceId, input.workspaceId),
        eq(schema.workspaceInstructionPolicyOnboardingProposals.kind, input.kind),
        eq(schema.workspaceInstructionPolicyOnboardingProposals.scope, input.scope),
        input.roleKey === null
          ? isNull(schema.workspaceInstructionPolicyOnboardingProposals.roleKey)
          : eq(schema.workspaceInstructionPolicyOnboardingProposals.roleKey, input.roleKey),
        eq(schema.workspaceInstructionPolicyOnboardingProposals.sourceId, input.sourceId),
        eq(schema.workspaceInstructionPolicyOnboardingProposals.sourceVersion, input.sourceVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function resolveOnboardingProposalInTransaction(
  db: Database,
  row: OnboardingProposalRow,
): Promise<WorkspaceInstructionPolicyOnboardingProposal> {
  const draftRow = await getRevisionInTransaction(db, row.workspaceId, row.draftRevisionId);
  if (!draftRow) {
    throw new Error("Workspace instruction-policy onboarding proposal lost its draft revision");
  }
  return onboardingProposalFromRow(row, draftRow);
}

async function getHeadInTransaction(
  db: Database,
  workspaceId: string,
  target: WorkspaceInstructionPolicyTarget,
): Promise<HeadRow | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceInstructionPolicyHeads)
    .where(and(...headTargetConditions(workspaceId, target)))
    .for("update")
    .limit(1);
  return row ?? null;
}

function sameTarget(
  left: Pick<WorkspaceInstructionPolicyRevision, "kind" | "scope" | "roleKey">,
  right: WorkspaceInstructionPolicyTarget,
): boolean {
  return left.kind === right.kind && left.scope === right.scope && left.roleKey === right.roleKey;
}

function draftReceiptMatches(row: RevisionRow, input: DraftInput): boolean {
  return (
    row.createdBySubjectId === input.createdBySubjectId &&
    row.kind === input.kind &&
    row.scope === input.scope &&
    row.roleKey === input.roleKey &&
    row.content === input.content &&
    row.provenanceSource === input.provenanceSource &&
    row.provenanceSourceId === input.provenanceSourceId &&
    row.supersedesRevisionId === input.supersedesRevisionId
  );
}

async function createDraftInTransaction(
  db: Database,
  input: DraftInput,
): Promise<WorkspaceInstructionPolicyRevision> {
  if (await getEventByOperationInTransaction(db, input.workspaceId, input.operationId)) {
    throw new WorkspaceInstructionPolicyOperationReuseError();
  }
  const existing = await getRevisionByOperationInTransaction(
    db,
    input.workspaceId,
    input.operationId,
  );
  if (existing) {
    if (
      existing.requestFingerprint === null
        ? !draftReceiptMatches(existing, input)
        : existing.requestFingerprint !== input.requestFingerprint
    ) {
      throw new WorkspaceInstructionPolicyOperationReuseError();
    }
    return revisionFromRow(existing);
  }
  if (input.supersedesRevisionId !== null) {
    const superseded = await getRevisionInTransaction(
      db,
      input.workspaceId,
      input.supersedesRevisionId,
    );
    if (!superseded || !sameTarget(revisionFromRow(superseded), input)) {
      throw new WorkspaceInstructionPolicyInvalidOperationError(
        "A superseded revision must exist in the same workspace and instruction-policy target",
      );
    }
  }
  const [created] = await db
    .insert(schema.workspaceInstructionPolicyRevisions)
    .values({
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      scope: input.scope,
      roleKey: input.roleKey,
      content: input.content,
      contentHash: contentHash(input.content),
      provenanceSource: input.provenanceSource,
      provenanceSourceId: input.provenanceSourceId,
      supersedesRevisionId: input.supersedesRevisionId,
      createdBySubjectId: input.createdBySubjectId,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const concurrent = await getRevisionByOperationInTransaction(
      db,
      input.workspaceId,
      input.operationId,
    );
    if (!concurrent || concurrent.requestFingerprint !== input.requestFingerprint) {
      throw new WorkspaceInstructionPolicyOperationReuseError();
    }
    return revisionFromRow(concurrent);
  }
  return revisionFromRow(created);
}

export async function createWorkspaceInstructionPolicyDraft(
  db: Database,
  input: CallerDraftInput,
): Promise<WorkspaceInstructionPolicyRevision> {
  const request = { ...input, operationId: input.operationId ?? randomUUID() };
  const normalized = { ...request, requestFingerprint: draftRequestFingerprint(request) };
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await lockWorkspace(scopedDb, input);
      return await createDraftInTransaction(scopedDb, normalized);
    },
  );
}

/** Import only the stored legacy override; never materialize a deployment default or activate it. */
export async function importLegacyWorkspaceInstructionPolicyDraft(
  db: Database,
  input: Omit<ImportLegacyRequestInput, "operationId"> & { operationId?: string },
): Promise<WorkspaceInstructionPolicyRevision> {
  const request = { ...input, operationId: input.operationId ?? randomUUID() };
  const normalized = {
    ...request,
    requestFingerprint: importLegacyRequestFingerprint(request),
  };
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const workspace = await lockWorkspace(scopedDb, input);
      if (
        await getEventByOperationInTransaction(scopedDb, input.workspaceId, normalized.operationId)
      ) {
        throw new WorkspaceInstructionPolicyOperationReuseError();
      }
      const existing = await getRevisionByOperationInTransaction(
        scopedDb,
        input.workspaceId,
        normalized.operationId,
      );
      if (existing) {
        if (
          existing.requestFingerprint === null
            ? existing.createdBySubjectId !== input.createdBySubjectId ||
              existing.kind !== "charter" ||
              existing.scope !== "global" ||
              existing.roleKey !== null ||
              existing.provenanceSource !== "legacy_import" ||
              existing.provenanceSourceId !== "workspaces.agent_instructions" ||
              existing.supersedesRevisionId !== input.supersedesRevisionId
            : existing.requestFingerprint !== normalized.requestFingerprint
        ) {
          throw new WorkspaceInstructionPolicyOperationReuseError();
        }
        return revisionFromRow(existing);
      }
      if (workspace.agentInstructions === null) {
        throw new WorkspaceInstructionPolicyLegacyUnavailableError();
      }
      if (
        workspace.agentInstructions.trim().length === 0 ||
        workspace.agentInstructions.length > WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS
      ) {
        throw new WorkspaceInstructionPolicyInvalidOperationError(
          "Legacy agent instructions do not fit the workspace instruction-policy draft contract",
        );
      }
      return await createDraftInTransaction(scopedDb, {
        ...normalized,
        kind: "charter",
        scope: "global",
        roleKey: null,
        content: workspace.agentInstructions,
        provenanceSource: "legacy_import",
        provenanceSourceId: "workspaces.agent_instructions",
      });
    },
  );
}

export async function createWorkspaceInstructionPolicyOnboardingProposal(
  db: Database,
  input: Omit<OnboardingProposalRequestInput, "operationId"> & { operationId?: string },
): Promise<WorkspaceInstructionPolicyOnboardingProposal> {
  if (input.content.trim().length === 0) {
    throw new WorkspaceInstructionPolicyOnboardingProposalContentError(
      "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY",
    );
  }
  if (input.content.length > WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS) {
    throw new WorkspaceInstructionPolicyOnboardingProposalContentError(
      "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED",
    );
  }
  const request: OnboardingProposalRequestInput = {
    ...input,
    operationId: input.operationId ?? randomUUID(),
    sourceId: input.sourceId.trim(),
    sourceVersion: input.sourceVersion.trim(),
  };
  const normalized: OnboardingProposalInput = {
    ...request,
    requestFingerprint: onboardingProposalRequestFingerprint(request),
  };
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await lockWorkspace(scopedDb, input);
      const existing = await getOnboardingProposalByOperationInTransaction(
        scopedDb,
        input.workspaceId,
        normalized.operationId,
      );
      if (existing) {
        if (existing.requestFingerprint !== normalized.requestFingerprint) {
          throw new WorkspaceInstructionPolicyOperationReuseError();
        }
        return await resolveOnboardingProposalInTransaction(scopedDb, existing);
      }
      if (
        (await getEventByOperationInTransaction(
          scopedDb,
          input.workspaceId,
          normalized.operationId,
        )) ||
        (await getRevisionByOperationInTransaction(
          scopedDb,
          input.workspaceId,
          normalized.operationId,
        ))
      ) {
        throw new WorkspaceInstructionPolicyOperationReuseError();
      }

      const target: WorkspaceInstructionPolicyTarget = {
        kind: normalized.kind,
        scope: normalized.scope,
        roleKey: normalized.roleKey,
      };
      const currentRow = await getHeadInTransaction(scopedDb, input.workspaceId, target);
      const currentHead = currentRow ? headFromRow(currentRow) : null;
      if (
        (currentHead?.revisionId ?? null) !== normalized.expectedCurrentRevisionId ||
        (currentHead?.activationVersion ?? 0) !== normalized.expectedActivationVersion
      ) {
        throw new WorkspaceInstructionPolicyOnboardingProposalStaleError(currentHead);
      }

      const sourceConflict = await getOnboardingProposalBySourceVersionInTransaction(
        scopedDb,
        normalized,
      );
      if (sourceConflict) {
        throw new WorkspaceInstructionPolicyOnboardingProposalConflictError(
          sourceConflict.id,
          sourceConflict.draftRevisionId,
        );
      }

      const proposalId = randomUUID();
      const draft = await createDraftInTransaction(scopedDb, {
        operationId: normalized.operationId,
        requestFingerprint: normalized.requestFingerprint,
        accountId: normalized.accountId,
        workspaceId: normalized.workspaceId,
        kind: normalized.kind,
        scope: normalized.scope,
        roleKey: normalized.roleKey,
        content: normalized.content,
        provenanceSource: "onboarding",
        provenanceSourceId: proposalId,
        supersedesRevisionId: currentHead?.revisionId ?? null,
        createdBySubjectId: normalized.createdBySubjectId,
      });
      const createdAt = new Date();
      const [created] = await scopedDb
        .insert(schema.workspaceInstructionPolicyOnboardingProposals)
        .values({
          id: proposalId,
          operationId: normalized.operationId,
          requestFingerprint: normalized.requestFingerprint,
          accountId: normalized.accountId,
          workspaceId: normalized.workspaceId,
          kind: normalized.kind,
          scope: normalized.scope,
          roleKey: normalized.roleKey,
          sourceId: normalized.sourceId,
          sourceVersion: normalized.sourceVersion,
          confidenceBps: normalized.confidenceBps,
          baselineRevisionId: currentHead?.revisionId ?? null,
          baselineRevision: currentHead?.revision ?? null,
          baselineContentHash: currentHead?.contentHash ?? null,
          baselineActivationVersion: currentHead?.activationVersion ?? 0,
          baselineActivatedAt: currentHead ? new Date(currentHead.activatedAt) : null,
          draftRevisionId: draft.id,
          draftRevision: draft.revision,
          draftContentHash: draft.contentHash,
          status: "proposed",
          createdBySubjectId: normalized.createdBySubjectId,
          createdAt,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        const draftRow = await getRevisionInTransaction(scopedDb, input.workspaceId, draft.id);
        if (!draftRow) throw new Error("Onboarding proposal draft was not recorded");
        return onboardingProposalFromRow(created, draftRow);
      }

      const concurrentOperation = await getOnboardingProposalByOperationInTransaction(
        scopedDb,
        input.workspaceId,
        normalized.operationId,
      );
      if (concurrentOperation) {
        if (concurrentOperation.requestFingerprint !== normalized.requestFingerprint) {
          throw new WorkspaceInstructionPolicyOperationReuseError();
        }
        return await resolveOnboardingProposalInTransaction(scopedDb, concurrentOperation);
      }
      const concurrentSource = await getOnboardingProposalBySourceVersionInTransaction(
        scopedDb,
        normalized,
      );
      if (concurrentSource) {
        throw new WorkspaceInstructionPolicyOnboardingProposalConflictError(
          concurrentSource.id,
          concurrentSource.draftRevisionId,
        );
      }
      throw new Error("Workspace instruction-policy onboarding proposal was not created");
    },
  );
}

export async function listWorkspaceInstructionPolicyOnboardingProposals(
  db: Database,
  workspaceId: string,
  query: WorkspaceInstructionPolicyOnboardingProposalListQuery,
): Promise<WorkspaceInstructionPolicyOnboardingProposalListResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceInstructionPolicyOnboardingProposals)
      .where(eq(schema.workspaceInstructionPolicyOnboardingProposals.workspaceId, workspaceId))
      .orderBy(
        desc(schema.workspaceInstructionPolicyOnboardingProposals.createdAt),
        desc(schema.workspaceInstructionPolicyOnboardingProposals.id),
      )
      .limit(query.limit + 1);
    const truncated = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (page.length === 0) return { proposals: [], truncated };
    const revisions = await scopedDb
      .select()
      .from(schema.workspaceInstructionPolicyRevisions)
      .where(
        and(
          eq(schema.workspaceInstructionPolicyRevisions.workspaceId, workspaceId),
          inArray(
            schema.workspaceInstructionPolicyRevisions.id,
            page.map((proposal) => proposal.draftRevisionId),
          ),
        ),
      );
    const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
    return {
      proposals: page.map((proposal) => {
        const draft = revisionsById.get(proposal.draftRevisionId);
        if (!draft) {
          throw new Error("Workspace instruction-policy onboarding proposal lost its draft");
        }
        return onboardingProposalFromRow(proposal, draft);
      }),
      truncated,
    };
  });
}

function listFilterConditions(
  workspaceId: string,
  query: WorkspaceInstructionPolicyListQuery,
): SQL[] {
  const conditions: SQL[] = [
    eq(schema.workspaceInstructionPolicyRevisions.workspaceId, workspaceId),
  ];
  if (query.kind !== undefined) {
    conditions.push(eq(schema.workspaceInstructionPolicyRevisions.kind, query.kind));
  }
  if (query.scope !== undefined) {
    conditions.push(eq(schema.workspaceInstructionPolicyRevisions.scope, query.scope));
  }
  if (query.roleKey !== undefined) {
    conditions.push(
      query.roleKey === null
        ? isNull(schema.workspaceInstructionPolicyRevisions.roleKey)
        : eq(schema.workspaceInstructionPolicyRevisions.roleKey, query.roleKey),
    );
  }
  if (query.afterRevision !== undefined) {
    conditions.push(lt(schema.workspaceInstructionPolicyRevisions.revision, query.afterRevision));
  }
  return conditions;
}

export async function listWorkspaceInstructionPolicyRevisions(
  db: Database,
  workspaceId: string,
  query: WorkspaceInstructionPolicyListQuery,
): Promise<WorkspaceInstructionPolicyListResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceInstructionPolicyRevisions)
      .where(and(...listFilterConditions(workspaceId, query)))
      .orderBy(desc(schema.workspaceInstructionPolicyRevisions.revision))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const [heads, events] = await Promise.all([
      scopedDb
        .select()
        .from(schema.workspaceInstructionPolicyHeads)
        .where(eq(schema.workspaceInstructionPolicyHeads.workspaceId, workspaceId))
        .orderBy(
          asc(schema.workspaceInstructionPolicyHeads.kind),
          asc(schema.workspaceInstructionPolicyHeads.scope),
          asc(schema.workspaceInstructionPolicyHeads.roleKey),
        ),
      scopedDb
        .select()
        .from(schema.workspaceInstructionPolicyActivationEvents)
        .where(eq(schema.workspaceInstructionPolicyActivationEvents.workspaceId, workspaceId))
        .orderBy(
          desc(schema.workspaceInstructionPolicyActivationEvents.createdAt),
          desc(schema.workspaceInstructionPolicyActivationEvents.id),
        )
        .limit(query.limit),
    ]);
    return {
      revisions: page.map(revisionFromRow),
      activeHeads: heads.map(headFromRow),
      activationEvents: events.map(eventFromRow),
      nextAfterRevision: hasMore ? page.at(-1)!.revision : null,
    };
  });
}

export async function getWorkspaceInstructionPolicyRevision(
  db: Database,
  workspaceId: string,
  revisionId: string,
): Promise<WorkspaceInstructionPolicyRevision> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const row = await getRevisionInTransaction(scopedDb, workspaceId, revisionId);
    if (!row) throw new WorkspaceInstructionPolicyNotFoundError();
    return revisionFromRow(row);
  });
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

/** Deterministic, dependency-free unified line diff; large inputs degrade to a full replacement. */
export function diffWorkspaceInstructionPolicyContent(
  from: WorkspaceInstructionPolicyRevision,
  to: WorkspaceInstructionPolicyRevision,
): string {
  const header = `--- revision-${from.revision}\n+++ revision-${to.revision}\n`;
  if (from.content === to.content) return header;
  const before = splitLines(from.content);
  const after = splitLines(to.content);
  const operations: Array<{ prefix: " " | "+" | "-"; line: string }> = [];
  if ((before.length + 1) * (after.length + 1) <= 1_000_000) {
    const width = after.length + 1;
    const table = new Uint32Array((before.length + 1) * width);
    for (let left = before.length - 1; left >= 0; left -= 1) {
      for (let right = after.length - 1; right >= 0; right -= 1) {
        const offset = left * width + right;
        table[offset] =
          before[left] === after[right]
            ? table[(left + 1) * width + right + 1]! + 1
            : Math.max(table[(left + 1) * width + right]!, table[left * width + right + 1]!);
      }
    }
    let left = 0;
    let right = 0;
    while (left < before.length || right < after.length) {
      if (left < before.length && right < after.length && before[left] === after[right]) {
        operations.push({ prefix: " ", line: before[left]! });
        left += 1;
        right += 1;
      } else if (
        right < after.length &&
        (left === before.length ||
          table[left * width + right + 1]! >= table[(left + 1) * width + right]!)
      ) {
        operations.push({ prefix: "+", line: after[right]! });
        right += 1;
      } else {
        operations.push({ prefix: "-", line: before[left]! });
        left += 1;
      }
    }
  } else {
    operations.push(...before.map((line) => ({ prefix: "-" as const, line })));
    operations.push(...after.map((line) => ({ prefix: "+" as const, line })));
  }
  const hunk = `@@ -1,${before.length} +1,${after.length} @@\n`;
  return `${header}${hunk}${operations.map(({ prefix, line }) => `${prefix}${line}\n`).join("")}`;
}

export async function diffWorkspaceInstructionPolicyRevisions(
  db: Database,
  workspaceId: string,
  input: { fromRevisionId: string; toRevisionId: string },
): Promise<WorkspaceInstructionPolicyDiffResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [fromRow, toRow] = await Promise.all([
      getRevisionInTransaction(scopedDb, workspaceId, input.fromRevisionId),
      getRevisionInTransaction(scopedDb, workspaceId, input.toRevisionId),
    ]);
    if (!fromRow || !toRow) throw new WorkspaceInstructionPolicyNotFoundError();
    const from = revisionFromRow(fromRow);
    const to = revisionFromRow(toRow);
    if (!sameTarget(from, to)) {
      throw new WorkspaceInstructionPolicyInvalidOperationError(
        "Instruction-policy diffs require revisions from the same target",
      );
    }
    return { from, to, format: "unified", diff: diffWorkspaceInstructionPolicyContent(from, to) };
  });
}

async function changeActiveRevision(
  db: Database,
  input: ActiveRevisionInput,
): Promise<WorkspaceInstructionPolicyActivationResponse> {
  const requestFingerprint = activeRevisionRequestFingerprint(input);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // This row lock serializes both an absent-head first activation and later
      // updates, so every loser can return the authoritative typed conflict.
      await lockWorkspace(scopedDb, input);
      if (
        await getRevisionByOperationInTransaction(scopedDb, input.workspaceId, input.operationId)
      ) {
        throw new WorkspaceInstructionPolicyOperationReuseError();
      }
      const existingEvent = await getEventByOperationInTransaction(
        scopedDb,
        input.workspaceId,
        input.operationId,
      );
      if (existingEvent) {
        const legacyRequestMatches =
          hasOwnField(input, "expectedCurrentRevisionId") &&
          !hasOwnField(input, "expectedActivationVersion") &&
          existingEvent.type === input.type &&
          existingEvent.newRevisionId === input.targetRevisionId &&
          existingEvent.oldRevisionId === input.expectedCurrentRevisionId &&
          existingEvent.actorSubjectId === input.actorSubjectId &&
          existingEvent.reason === input.reason;
        if (
          existingEvent.requestFingerprint === null
            ? !legacyRequestMatches
            : existingEvent.requestFingerprint !== requestFingerprint
        ) {
          throw new WorkspaceInstructionPolicyOperationReuseError();
        }
        return { head: headFromEventRow(existingEvent), event: eventFromRow(existingEvent) };
      }
      const targetRow = await getRevisionInTransaction(
        scopedDb,
        input.workspaceId,
        input.targetRevisionId,
      );
      if (!targetRow) throw new WorkspaceInstructionPolicyNotFoundError();
      const target = revisionFromRow(targetRow);
      const targetIdentity: WorkspaceInstructionPolicyTarget = {
        kind: target.kind,
        scope: target.scope,
        roleKey: target.roleKey,
      };
      const currentRow = await getHeadInTransaction(scopedDb, input.workspaceId, targetIdentity);
      const currentHead = currentRow ? headFromRow(currentRow) : null;
      if (
        (currentHead?.revisionId ?? null) !== input.expectedCurrentRevisionId ||
        (input.expectedActivationVersion !== undefined &&
          (currentHead?.activationVersion ?? 0) !== input.expectedActivationVersion)
      ) {
        throw new WorkspaceInstructionPolicyConflictError(currentHead);
      }
      if (currentHead?.revisionId === target.id) {
        throw new WorkspaceInstructionPolicyInvalidOperationError(
          "The requested instruction-policy revision is already active",
        );
      }
      if (input.type === "rollback") {
        if (!currentHead) {
          throw new WorkspaceInstructionPolicyInvalidOperationError(
            "A workspace instruction policy with no active head cannot be rolled back",
          );
        }
        const [previousActivation] = await scopedDb
          .select({ id: schema.workspaceInstructionPolicyActivationEvents.id })
          .from(schema.workspaceInstructionPolicyActivationEvents)
          .where(
            and(
              ...eventTargetConditions(input.workspaceId, targetIdentity),
              eq(schema.workspaceInstructionPolicyActivationEvents.newRevisionId, target.id),
            ),
          )
          .limit(1);
        if (!previousActivation) {
          throw new WorkspaceInstructionPolicyInvalidOperationError(
            "Rollback targets must have been active previously",
          );
        }
      }
      const activationVersion = (currentHead?.activationVersion ?? 0) + 1;
      const createdAt = new Date();
      const [eventRow] = await scopedDb
        .insert(schema.workspaceInstructionPolicyActivationEvents)
        .values({
          operationId: input.operationId,
          requestFingerprint,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          ...targetIdentity,
          type: input.type,
          activationVersion,
          oldRevisionId: currentHead?.revisionId ?? null,
          oldRevision: currentHead?.revision ?? null,
          oldContentHash: currentHead?.contentHash ?? null,
          newRevisionId: target.id,
          newRevision: target.revision,
          newContentHash: target.contentHash,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
          createdAt,
        })
        .returning();
      if (!eventRow) throw new Error("Instruction-policy activation event was not recorded");
      let headRow: HeadRow | undefined;
      if (currentRow) {
        [headRow] = await scopedDb
          .update(schema.workspaceInstructionPolicyHeads)
          .set({
            revisionId: target.id,
            revision: target.revision,
            contentHash: target.contentHash,
            activationVersion,
            activatedAt: createdAt,
          })
          .where(eq(schema.workspaceInstructionPolicyHeads.id, currentRow.id))
          .returning();
      } else {
        [headRow] = await scopedDb
          .insert(schema.workspaceInstructionPolicyHeads)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            ...targetIdentity,
            revisionId: target.id,
            revision: target.revision,
            contentHash: target.contentHash,
            activationVersion,
            activatedAt: createdAt,
          })
          .returning();
      }
      if (!headRow) throw new Error("Instruction-policy activation head was not recorded");
      return { head: headFromRow(headRow), event: eventFromRow(eventRow) };
    },
  );
}

export async function activateWorkspaceInstructionPolicyRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    revisionId: string;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion?: number;
    actorSubjectId: string;
    reason: string;
  },
): Promise<WorkspaceInstructionPolicyActivationResponse> {
  return await changeActiveRevision(db, {
    ...input,
    operationId: input.operationId ?? randomUUID(),
    targetRevisionId: input.revisionId,
    type: "activate",
  });
}

export async function rollbackWorkspaceInstructionPolicyRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    targetRevisionId: string;
    expectedCurrentRevisionId: string;
    expectedActivationVersion?: number;
    actorSubjectId: string;
    reason: string;
  },
): Promise<WorkspaceInstructionPolicyActivationResponse> {
  return await changeActiveRevision(db, {
    ...input,
    operationId: input.operationId ?? randomUUID(),
    type: "rollback",
  });
}

/**
 * Freeze (or replay) the exact active charter/global/role policy set for one
 * accepted attempt, then resolve only those immutable revisions. The snapshot
 * stores bounded descriptors/hashes; full policy text remains in the revision
 * table and cannot be widened by a later head activation.
 */
export async function getOrCreateWorkspaceInstructionPolicySnapshot(
  db: Database,
  claims: WorkspaceInstructionPolicyAttemptClaims,
) {
  try {
    return await withWorkspaceRls(db, claims.workspaceId, async (scopedDb) => {
      const rows = (await scopedDb.execute(sql`
        SELECT
          snapshot.id,
          snapshot.workspace_id AS "workspaceId",
          snapshot.session_id AS "sessionId",
          snapshot.turn_id AS "turnId",
          snapshot.attempt_id AS "attemptId",
          snapshot.execution_generation AS "executionGeneration",
          snapshot.policy_role AS "policyRole",
          snapshot.role_source AS "roleSource",
          snapshot.entries,
          snapshot.entry_hash AS "entryHash",
          snapshot.created_at AS "createdAt"
        FROM workspace_instruction_policy_get_or_create_snapshot(
          ${claims.accountId}::uuid,
          ${claims.workspaceId}::uuid,
          ${claims.sessionId}::uuid,
          ${claims.turnId}::uuid,
          ${claims.attemptId}::uuid,
          ${claims.executionGeneration}
        ) snapshot
      `)) as unknown as Array<{
        id: string;
        workspaceId: string;
        sessionId: string;
        turnId: string;
        attemptId: string;
        executionGeneration: number;
        policyRole: string | null;
        roleSource: string;
        entries: unknown;
        entryHash: string;
        createdAt: Date | string;
      }>;
      const row = rows[0];
      if (!row) {
        throw new WorkspaceInstructionPolicySnapshotAuthorityError(
          "Instruction-policy snapshot authority conflicts with the accepted attempt",
        );
      }
      const snapshot = WorkspaceInstructionPolicySnapshot.parse({
        ...row,
        createdAt: iso(row.createdAt),
      });
      if (snapshot.entries.length === 0) {
        return ResolvedWorkspaceInstructionPolicySnapshot.parse(snapshot);
      }

      const revisionIds = snapshot.entries.map((entry) => entry.revisionId);
      const revisions = await scopedDb
        .select()
        .from(schema.workspaceInstructionPolicyRevisions)
        .where(
          and(
            eq(schema.workspaceInstructionPolicyRevisions.accountId, claims.accountId),
            eq(schema.workspaceInstructionPolicyRevisions.workspaceId, claims.workspaceId),
            inArray(schema.workspaceInstructionPolicyRevisions.id, revisionIds),
          ),
        );
      const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
      const resolvedEntries = snapshot.entries.map((entry) => {
        const revision = revisionsById.get(entry.revisionId);
        if (!revision || !snapshotEntryMatchesRevision(entry, revision)) {
          throw new WorkspaceInstructionPolicyInvalidOperationError(
            "Instruction-policy snapshot references an inexact immutable revision",
          );
        }
        return { ...entry, content: revision.content };
      });
      return ResolvedWorkspaceInstructionPolicySnapshot.parse({
        ...snapshot,
        entries: resolvedEntries,
      });
    });
  } catch (error) {
    if (["40001", "42501"].includes(nestedPostgresSqlState(error) ?? "")) {
      throw new WorkspaceInstructionPolicySnapshotAuthorityError(
        "Instruction-policy snapshot requires the exact current attempt and generation",
      );
    }
    throw error;
  }
}

function snapshotEntryMatchesRevision(
  entry: WorkspaceInstructionPolicySnapshotEntry,
  revision: RevisionRow,
): boolean {
  return (
    revision.id === entry.revisionId &&
    revision.revision === entry.revision &&
    revision.contentHash === entry.contentHash &&
    revision.kind === entry.kind &&
    revision.scope === entry.scope &&
    revision.roleKey === entry.roleKey
  );
}
