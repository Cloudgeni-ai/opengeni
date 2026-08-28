import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

// Exact lifecycle-only mutation, immutable revisions, FORCE RLS, and runtime
// grants are owned by the work-claim migration. The application role receives
// SELECT on the compact head plus EXECUTE on exact-attempt mutation routines,
// never direct DML authority.
export const sessionWorkClaims = pgTable(
  "session_work_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    subjectNamespace: text("subject_namespace").notNull(),
    subjectType: text("subject_type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    displayLabel: text("display_label"),
    role: text("role").notNull(),
    state: text("state").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    provenance: text("provenance").notNull(),
    versionKind: text("version_kind"),
    versionValue: text("version_value"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("session_work_claims_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    activeIdentity: uniqueIndex("session_work_claims_active_identity_uq")
      .on(
        table.workspaceId,
        table.sessionId,
        table.subjectNamespace,
        table.subjectType,
        table.subjectDigest,
        table.role,
      )
      .where(sql`${table.state} = 'active'`),
    sessionState: index("session_work_claims_session_state_idx").on(
      table.workspaceId,
      table.sessionId,
      table.state,
      table.updatedAt,
      table.id,
    ),
    subjectState: index("session_work_claims_subject_state_idx").on(
      table.workspaceId,
      table.subjectNamespace,
      table.subjectType,
      table.subjectDigest,
      table.state,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const sessionWorkClaimRevisions = pgTable(
  "session_work_claim_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    mutationKind: text("mutation_kind").notNull(),
    priorRevision: integer("prior_revision"),
    resultingRevision: integer("resulting_revision").notNull(),
    subjectNamespace: text("subject_namespace").notNull(),
    subjectType: text("subject_type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    displayLabel: text("display_label"),
    role: text("role").notNull(),
    state: text("state").notNull(),
    provenance: text("provenance").notNull(),
    versionKind: text("version_kind"),
    versionValue: text("version_value"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    claimCreatedAt: timestamp("claim_created_at", { withTimezone: true }).notNull(),
    claimUpdatedAt: timestamp("claim_updated_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    actorKind: text("actor_kind").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    actorSessionId: uuid("actor_session_id"),
    actorTurnId: uuid("actor_turn_id"),
    actorAttemptId: uuid("actor_attempt_id"),
    actorExecutionGeneration: integer("actor_execution_generation"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("session_work_claim_revisions_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    claimRevision: uniqueIndex("session_work_claim_revisions_claim_revision_uq").on(
      table.workspaceId,
      table.claimId,
      table.resultingRevision,
    ),
    sessionTimeline: index("session_work_claim_revisions_session_timeline_idx").on(
      table.workspaceId,
      table.sessionId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const sessionWorkClaimWriteCapabilities = pgTable(
  "session_work_claim_write_capabilities",
  {
    backendPid: integer("backend_pid").notNull(),
    transactionId: xid8("transaction_id").notNull(),
    capabilityId: uuid("capability_id").notNull(),
  },
  (table) => ({
    identity: primaryKey({
      columns: [table.backendPid, table.transactionId, table.capabilityId],
    }),
  }),
);
