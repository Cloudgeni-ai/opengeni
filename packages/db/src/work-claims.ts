import {
  WorkClaim,
  WorkClaimCanonicalKey,
  WorkClaimDisplayLabel,
  WorkClaimMutationKind,
  WorkClaimMutationResult,
  WorkClaimNamespace,
  WorkClaimReleaseReason,
  WorkClaimRole,
  WorkClaimSubjectType,
  WorkClaimVersionKind,
  WorkClaimVersionValue,
  normalizeWorkClaimCanonicalKey,
  normalizeWorkClaimDisplayLabel,
  normalizeWorkClaimNamespace,
  type WorkClaimRole as WorkClaimRoleType,
  type WorkClaimSubjectType as WorkClaimSubjectTypeType,
  type WorkClaimVersionKind as WorkClaimVersionKindType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withSessionActivityRlsContext } from "./database";

export type WorkClaimAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type UpsertWorkClaimInput = WorkClaimAttemptClaims & {
  operationId: string;
  expectedRevision: number;
  subjectNamespace: string;
  subjectType: WorkClaimSubjectTypeType;
  canonicalKey: string;
  displayLabel?: string | null;
  role: WorkClaimRoleType;
  version?: {
    kind: WorkClaimVersionKindType;
    value: string;
  } | null;
};

export type ReleaseWorkClaimInput = WorkClaimAttemptClaims & {
  operationId: string;
  claimId: string;
  expectedRevision: number;
  reason: string;
};

type WorkClaimMutationRow = {
  claim_id: string;
  session_id: string;
  root_session_id: string;
  subject_namespace: string;
  subject_type: string;
  canonical_key: string;
  display_label: string | null;
  role: string;
  state: string;
  revision: number;
  provenance: string;
  version_kind: string | null;
  version_value: string | null;
  observed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  settled_at: Date | string | null;
  mutation_kind: string;
  replayed: boolean;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function assertAttemptClaims(claims: WorkClaimAttemptClaims): void {
  if (!Number.isSafeInteger(claims.executionGeneration) || claims.executionGeneration < 1) {
    throw new Error("Work claims require a positive exact execution generation");
  }
}

function mutationResultFromRow(row: WorkClaimMutationRow) {
  const version =
    row.version_kind === null || row.version_value === null
      ? null
      : {
          kind: WorkClaimVersionKind.parse(row.version_kind),
          value: WorkClaimVersionValue.parse(row.version_value),
        };
  return WorkClaimMutationResult.parse({
    claim: WorkClaim.parse({
      id: row.claim_id,
      sessionId: row.session_id,
      rootSessionId: row.root_session_id,
      subject: {
        namespace: row.subject_namespace,
        type: row.subject_type,
        canonicalKey: row.canonical_key,
        displayLabel: row.display_label,
      },
      role: row.role,
      state: row.state,
      revision: Number(row.revision),
      provenance: row.provenance,
      version,
      observedAt: iso(row.observed_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      settledAt: row.settled_at === null ? null : iso(row.settled_at),
    }),
    mutation: WorkClaimMutationKind.parse(row.mutation_kind),
    replayed: row.replayed,
  });
}

export async function upsertWorkClaim(db: Database, input: UpsertWorkClaimInput) {
  assertAttemptClaims(input);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("Work claim expectedRevision must be a non-negative safe integer");
  }
  const subjectNamespace = WorkClaimNamespace.parse(
    normalizeWorkClaimNamespace(input.subjectNamespace),
  );
  const subjectType = WorkClaimSubjectType.parse(input.subjectType);
  const canonicalKey = WorkClaimCanonicalKey.parse(
    normalizeWorkClaimCanonicalKey(input.canonicalKey),
  );
  const role = WorkClaimRole.parse(input.role);
  const displayLabel =
    input.displayLabel === undefined || input.displayLabel === null
      ? null
      : WorkClaimDisplayLabel.parse(normalizeWorkClaimDisplayLabel(input.displayLabel));
  const version = input.version
    ? {
        kind: WorkClaimVersionKind.parse(input.version.kind),
        value: WorkClaimVersionValue.parse(normalizeWorkClaimCanonicalKey(input.version.value)),
      }
    : null;
  const rows = await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<WorkClaimMutationRow>(
        tx,
        sql`SELECT * FROM upsert_session_work_claim_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.operationId}::uuid,
          ${input.expectedRevision}::integer,
          ${subjectNamespace}::text,
          ${subjectType}::text,
          ${canonicalKey}::text,
          ${displayLabel}::text,
          ${role}::text,
          ${version?.kind ?? null}::text,
          ${version?.value ?? null}::text
        )`,
      ),
  );
  if (rows.length !== 1) throw new Error("Work claim upsert returned no durable receipt");
  return mutationResultFromRow(rows[0]!);
}

export async function releaseWorkClaim(db: Database, input: ReleaseWorkClaimInput) {
  assertAttemptClaims(input);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Work claim release requires a positive expectedRevision");
  }
  const reason = WorkClaimReleaseReason.parse(input.reason);
  const rows = await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<WorkClaimMutationRow>(
        tx,
        sql`SELECT * FROM release_session_work_claim_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.operationId}::uuid,
          ${input.claimId}::uuid,
          ${input.expectedRevision}::integer,
          ${reason}::text
        )`,
      ),
  );
  if (rows.length !== 1) throw new Error("Work claim release returned no durable receipt");
  return mutationResultFromRow(rows[0]!);
}
