import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Foreign keys and the cross-row revision/head integrity triggers live in the
// SQL migration. Keeping this additive schema leaf independent avoids a cycle
// back into schema.ts while retaining one canonical Drizzle namespace export.

export const workspaceInstructionPolicyRevisions = pgTable(
  "workspace_instruction_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('workspace_instruction_policy_revision_seq')`),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    roleKey: text("role_key"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    provenanceSource: text("provenance_source").notNull(),
    provenanceSourceId: text("provenance_source_id"),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceRevision: uniqueIndex(
      "workspace_instruction_policy_revisions_workspace_revision_uq",
    ).on(table.workspaceId, table.revision),
    workspaceHistory: index("workspace_instruction_policy_revisions_workspace_history_idx").on(
      table.workspaceId,
      table.kind,
      table.scope,
      table.roleKey,
      table.revision,
    ),
    target: check(
      "workspace_instruction_policy_revisions_target_chk",
      sql`(
        (${table.kind} = 'charter' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'role' and ${table.roleKey} is not null)
      )`,
    ),
  }),
);

export const workspaceInstructionPolicyHeads = pgTable(
  "workspace_instruction_policy_heads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    roleKey: text("role_key"),
    revisionId: uuid("revision_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    charter: uniqueIndex("workspace_instruction_policy_heads_charter_uq")
      .on(table.workspaceId)
      .where(sql`${table.kind} = 'charter'`),
    globalPolicy: uniqueIndex("workspace_instruction_policy_heads_global_policy_uq")
      .on(table.workspaceId)
      .where(sql`${table.kind} = 'policy' and ${table.scope} = 'global'`),
    rolePolicy: uniqueIndex("workspace_instruction_policy_heads_role_policy_uq")
      .on(table.workspaceId, table.roleKey)
      .where(sql`${table.kind} = 'policy' and ${table.scope} = 'role'`),
    target: check(
      "workspace_instruction_policy_heads_target_chk",
      sql`(
        (${table.kind} = 'charter' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'role' and ${table.roleKey} is not null)
      )`,
    ),
  }),
);

export const workspaceInstructionPolicyActivationEvents = pgTable(
  "workspace_instruction_policy_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    roleKey: text("role_key"),
    type: text("type").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    oldRevisionId: uuid("old_revision_id"),
    oldRevision: bigint("old_revision", { mode: "number" }),
    oldContentHash: text("old_content_hash"),
    newRevisionId: uuid("new_revision_id").notNull(),
    newRevision: bigint("new_revision", { mode: "number" }).notNull(),
    newContentHash: text("new_content_hash").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceActivationVersion: uniqueIndex(
      "workspace_instruction_policy_events_target_version_uq",
    ).on(
      table.workspaceId,
      table.kind,
      table.scope,
      sql`coalesce(${table.roleKey}, '')`,
      table.activationVersion,
    ),
    workspaceTimeline: index("workspace_instruction_policy_events_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    target: check(
      "workspace_instruction_policy_activation_events_target_chk",
      sql`(
        (${table.kind} = 'charter' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'global' and ${table.roleKey} is null)
        or (${table.kind} = 'policy' and ${table.scope} = 'role' and ${table.roleKey} is not null)
      )`,
    ),
  }),
);
