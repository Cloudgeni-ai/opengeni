import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CompanyBrainMemorySelectionReference } from "./company-brain-context-selection";

/**
 * Content-free accepted-logical-turn selection receipt. Migration 0256 owns
 * the exact-attempt writer, immutable trigger, FORCE-RLS policy, and grants.
 */
export const companyBrainContextSelectionReceipts = pgTable(
  "company_brain_context_selection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    createdByAttemptId: uuid("created_by_attempt_id").notNull(),
    createdByExecutionGeneration: integer("created_by_execution_generation").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    sessionRole: text("session_role").notNull(),
    memoryEnabled: boolean("memory_enabled").notNull(),
    memoryPromptMode: text("memory_prompt_mode").notNull(),
    companyProfileIncluded: boolean("company_profile_included").notNull(),
    instructionPolicyEntryHash: text("instruction_policy_entry_hash").notNull(),
    preferenceDescriptorHash: text("preference_descriptor_hash"),
    companyProfileSnapshotHash: text("company_profile_snapshot_hash").notNull(),
    turnContextSnapshotId: uuid("turn_context_snapshot_id").notNull(),
    turnContextSnapshotHash: text("turn_context_snapshot_hash").notNull(),
    turnContextSnapshotSource: text("turn_context_snapshot_source").notNull(),
    memorySelections: jsonb("memory_selections")
      .$type<readonly CompanyBrainMemorySelectionReference[]>()
      .notNull(),
    renderedMemorySelections: jsonb("rendered_memory_selections")
      .$type<readonly CompanyBrainMemorySelectionReference[]>()
      .notNull(),
    selectionHash: text("selection_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    logicalTurn: uniqueIndex("company_brain_context_selection_turn_uq").on(
      table.workspaceId,
      table.turnId,
    ),
    workspaceTimeline: index("company_brain_context_selection_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

/**
 * Exact bounded accepted-turn authority that may contain the legacy workspace
 * instruction fallback. It is deliberately separate from the content-free
 * selection receipt and has no direct runtime table privileges.
 */
export const companyBrainTurnContextSnapshots = pgTable(
  "company_brain_turn_context_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    memoryEnabled: boolean("memory_enabled").notNull(),
    memoryPromptMode: text("memory_prompt_mode").notNull(),
    legacyWorkspaceInstructions: text("legacy_workspace_instructions"),
    legacyWorkspaceInstructionsOriginalUtf8Bytes: integer(
      "legacy_workspace_instructions_original_utf8_bytes",
    ),
    legacyWorkspaceInstructionsTruncated: boolean(
      "legacy_workspace_instructions_truncated",
    ).notNull(),
    snapshotSource: text("snapshot_source").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    logicalTurn: uniqueIndex("company_brain_turn_context_snapshot_turn_uq").on(
      table.workspaceId,
      table.turnId,
    ),
    workspaceIdentity: uniqueIndex("company_brain_turn_context_snapshot_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
  }),
);
