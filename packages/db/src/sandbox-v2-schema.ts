import type {
  SandboxMachineRecord,
  SandboxJournalCommand,
  SandboxJournalCursor,
  SandboxJournalObservation,
  SandboxMachineInstance,
  SandboxV2PreparationPlan,
  SandboxV2CredentialGenerationDefinition,
  SandboxV2CredentialTicket,
} from "@opengeni/contracts";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Migration-only legacy backfill plus permanent engine admission. The SQL
 * guard forbids changing or deleting a live tenant's claim. */
export const sandboxGroupEngines = pgTable(
  "sandbox_group_engines",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sandboxGroupId: uuid("sandbox_group_id").notNull(),
    engine: text("engine", { enum: ["legacy", "machine-v2"] }).notNull(),
  },
  (table) => ({ group: primaryKey({ columns: [table.workspaceId, table.sandboxGroupId] }) }),
);

/** Tenant FK, immutable identity/version trigger and FORCE-RLS policies are
 * installed by the v2 migration. No old group is backfilled into this table. */
export const sandboxV2Machines = pgTable(
  "sandbox_v2_machines",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sandboxGroupId: uuid("sandbox_group_id").notNull(),
    provider: text("provider").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    projection: jsonb("projection").$type<SandboxMachineRecord>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    group: uniqueIndex("sandbox_v2_machines_group_uq").on(table.workspaceId, table.sandboxGroupId),
    scope: uniqueIndex("sandbox_v2_machines_scope_uq").on(
      table.accountId,
      table.workspaceId,
      table.id,
    ),
    inventory: index("sandbox_v2_machines_inventory_idx").on(
      table.accountId,
      table.workspaceId,
      table.updatedAt,
      table.id,
    ),
  }),
);

/** Dispatch, input and capture authority remains outside a guest's disk history.
 * No legacy lease ID/epoch or executable credential-bearing body is required. */
export const sandboxV2Commands = pgTable(
  "sandbox_v2_commands",
  {
    operationId: uuid("operation_id").primaryKey(),
    handle: integer("handle").notNull().generatedAlwaysAsIdentity(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instanceId: text("instance_id").notNull(),
    acceptedActionId: text("accepted_action_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    binding: jsonb("binding").$type<SandboxJournalCommand>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    stdout: jsonb("stdout").$type<SandboxJournalCursor>().notNull(),
    stderr: jsonb("stderr").$type<SandboxJournalCursor>().notNull(),
    proof: jsonb("proof").$type<SandboxJournalObservation>(),
    abandoned: boolean("abandoned").notNull().default(false),
    nextInputSequence: bigint("next_input_sequence", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    handle: uniqueIndex("sandbox_v2_commands_handle_uq").on(table.handle),
    causal: uniqueIndex("sandbox_v2_commands_causal_uq").on(
      table.workspaceId,
      table.sessionId,
      table.turnId,
      table.acceptedActionId,
    ),
    pending: index("sandbox_v2_commands_pending_idx").on(
      table.workspaceId,
      table.attemptId,
      table.operationId,
    ),
  }),
);

export const sandboxV2CommandInputs = pgTable(
  "sandbox_v2_command_inputs",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    acceptedActionId: text("accepted_action_id").notNull(),
    partIndex: integer("part_index").notNull(),
    partCount: integer("part_count").notNull(),
    requestDigest: text("request_digest").notNull(),
    actionDigest: text("action_digest").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
  },
  (table) => ({
    causal: primaryKey({ columns: [table.operationId, table.acceptedActionId, table.partIndex] }),
    ordered: uniqueIndex("sandbox_v2_command_inputs_sequence_uq").on(
      table.operationId,
      table.sequence,
    ),
  }),
);

export const sandboxV2CommandOutput = pgTable(
  "sandbox_v2_command_output",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    acceptedActionId: text("accepted_action_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    observation: jsonb("observation").$type<SandboxJournalObservation>().notNull(),
    stdout: text("stdout").notNull(),
    stderr: text("stderr").notNull(),
  },
  (table) => ({ captured: primaryKey({ columns: [table.operationId, table.revision] }) }),
);

/** Immutable, attempt-bound host preparation. No credential envelope, signed
 * URL, input bytes or machine lifetime is stored in this plan. */
export const sandboxV2PreparationPlans = pgTable(
  "sandbox_v2_preparation_plans",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
    setupId: text("setup_id").notNull(),
    definitionDigest: text("definition_digest").notNull(),
    definition: jsonb("definition").$type<SandboxV2PreparationPlan>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    plan: primaryKey({
      columns: [table.workspaceId, table.sessionId, table.turnId, table.setupId],
    }),
  }),
);

/** Authenticated ciphertext only. A cleared generation retains its immutable
 * identity; the SQL guard permits erasure only after exact attempt quiescence. */
export const sandboxV2CredentialGenerations = pgTable(
  "sandbox_v2_credential_generations",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
    generationId: text("generation_id").notNull(),
    definition: jsonb("definition").$type<SandboxV2CredentialGenerationDefinition>().notNull(),
    ciphertext: text("ciphertext"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (table) => ({
    generation: primaryKey({
      columns: [table.workspaceId, table.sessionId, table.attemptId, table.generationId],
    }),
  }),
);

/** Original job material and its fixed cleanup custody. Ciphertext can only be
 * cleared with the exact cleanup's complete native exit acknowledgement. */
export const sandboxV2BackgroundCredentials = pgTable(
  "sandbox_v2_background_credentials",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    jobId: uuid("job_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
    generationId: text("generation_id").notNull(),
    definition: jsonb("definition").$type<SandboxV2CredentialGenerationDefinition>().notNull(),
    ciphertext: text("ciphertext"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    writerActionId: text("writer_action_id").notNull(),
    cleanupOperationId: uuid("cleanup_operation_id").notNull(),
    cleanupSpecificationDigest: text("cleanup_specification_digest").notNull(),
    cleanupRevision: bigint("cleanup_revision", { mode: "number" }).notNull().default(0),
    cleanupBinding: jsonb("cleanup_binding").$type<SandboxJournalCommand>(),
    cleanupProof: jsonb("cleanup_proof").$type<SandboxJournalObservation>(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generation: primaryKey({ columns: [table.workspaceId, table.sessionId, table.jobId] }),
    cleanup: uniqueIndex("sandbox_v2_background_credentials_cleanup_uq").on(
      table.cleanupOperationId,
    ),
  }),
);

/** Immutable prelaunch job custody. Registration itself does not remove any
 * command from the attempt writer gate or grant execution after turn closure. */
export const sandboxV2BackgroundOwners = pgTable("sandbox_v2_background_owners", {
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  jobId: uuid("job_id").primaryKey(),
  turnId: uuid("turn_id").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  executionGeneration: integer("execution_generation").notNull(),
  machineId: uuid("machine_id").notNull(),
  instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
  generationId: text("generation_id").notNull(),
  writerActionId: text("writer_action_id").notNull(),
  cleanupOperationId: uuid("cleanup_operation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Small attempt-owned activation head. Encrypted material is retained in its
 * immutable generation; this row serializes reservation and receipt activation. */
export const sandboxV2CredentialOwners = pgTable(
  "sandbox_v2_credential_owners",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
    setupId: text("setup_id").notNull(),
    initialGenerationId: text("initial_generation_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    active: jsonb("active").$type<SandboxV2CredentialTicket>(),
    pending: jsonb("pending").$type<SandboxV2CredentialTicket>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    owner: primaryKey({ columns: [table.workspaceId, table.sessionId, table.attemptId] }),
  }),
);

/** Retained, narrow guest cleanup after ordinary writers settle. This is not
 * agent command authority. Its exact native acknowledgement holds admission
 * and machine demand until this original attempt's versions are removed. */
export const sandboxV2CredentialCleanup = pgTable(
  "sandbox_v2_credential_cleanup",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    machineId: uuid("machine_id").notNull(),
    instance: jsonb("instance").$type<SandboxMachineInstance>().notNull(),
    operationId: uuid("operation_id").notNull(),
    specificationDigest: text("specification_digest").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    binding: jsonb("binding").$type<SandboxJournalCommand>(),
    proof: jsonb("proof").$type<SandboxJournalObservation>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    owner: primaryKey({ columns: [table.workspaceId, table.sessionId, table.attemptId] }),
    operation: uniqueIndex("sandbox_v2_credential_cleanup_operation_uq").on(table.operationId),
    pending: index("sandbox_v2_credential_cleanup_pending_idx").on(
      table.workspaceId,
      table.machineId,
    ),
  }),
);
