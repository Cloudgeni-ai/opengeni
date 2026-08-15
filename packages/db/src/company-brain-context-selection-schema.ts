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
    memorySelections: jsonb("memory_selections")
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
