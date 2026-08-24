import type { SlackTaskPolicyContent } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const slackTaskPolicyRevisions = pgTable(
  "slack_task_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('slack_task_policy_revision_seq')`),
    policy: jsonb("policy").$type<SlackTaskPolicyContent>().notNull(),
    policyHash: text("policy_hash").notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("slack_task_policy_revisions_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    workspaceRevision: uniqueIndex("slack_task_policy_revisions_workspace_revision_uq").on(
      table.workspaceId,
      table.revision,
    ),
    workspaceHistory: index("slack_task_policy_revisions_workspace_history_idx").on(
      table.workspaceId,
      table.revision,
    ),
    receipt: check(
      "slack_task_policy_revisions_receipt_chk",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$' and ${table.policyHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const slackTaskPolicyHeads = pgTable(
  "slack_task_policy_heads",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").primaryKey(),
    revisionId: uuid("revision_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    policyHash: text("policy_hash").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    account: index("slack_task_policy_heads_account_idx").on(table.accountId),
  }),
);

export const slackTaskPolicyActivationEvents = pgTable(
  "slack_task_policy_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    oldRevisionId: uuid("old_revision_id"),
    oldRevision: bigint("old_revision", { mode: "number" }),
    oldPolicyHash: text("old_policy_hash"),
    newRevisionId: uuid("new_revision_id").notNull(),
    newRevision: bigint("new_revision", { mode: "number" }).notNull(),
    newPolicyHash: text("new_policy_hash").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("slack_task_policy_events_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    workspaceVersion: uniqueIndex("slack_task_policy_events_workspace_version_uq").on(
      table.workspaceId,
      table.activationVersion,
    ),
    workspaceTimeline: index("slack_task_policy_events_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const slackSharedTaskOrigins = pgTable(
  "slack_shared_task_origins",
  {
    interactionId: uuid("interaction_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    sourceThreadTs: text("source_thread_ts").notNull(),
    initiatingSlackUserId: text("initiating_slack_user_id").notNull(),
    policyRevisionId: uuid("policy_revision_id").notNull(),
    // The Slack task policy is a home fact and the interaction is a routed one,
    // so the frozen revision carries its own tenancy pair. Null on rows written
    // before Slack workspace routing, where the two were always equal.
    policyAccountId: uuid("policy_account_id"),
    policyWorkspaceId: uuid("policy_workspace_id"),
    policyHash: text("policy_hash").notNull(),
    policyActivationVersion: bigint("policy_activation_version", { mode: "number" }).notNull(),
    publicationMode: text("publication_mode")
      .$type<"never" | "approval_required" | "allow">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSession: uniqueIndex("slack_shared_task_origins_workspace_session_uq").on(
      table.workspaceId,
      table.sessionId,
    ),
  }),
);
