import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const managedAuthBrowserInstallations = pgTable("managed_auth_browser_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorityHash: text("authority_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const managedAuthSessionSets = pgTable("managed_auth_session_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: uuid("installation_id").notNull().unique(),
  authorityHash: text("authority_hash").notNull().unique(),
  csrfHash: text("csrf_hash").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull().default(1),
  actorEpoch: bigint("actor_epoch", { mode: "number" }).notNull().default(1),
  selectedSlotId: uuid("selected_slot_id"),
  state: text("state").notNull().default("ready"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const managedAuthLoginSlots = pgTable(
  "managed_auth_login_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionSetId: uuid("session_set_id").notNull(),
    authSessionId: text("auth_session_id"),
    authUserId: text("auth_user_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    loginBindingId: uuid("login_binding_id").notNull(),
    identityRevision: bigint("identity_revision", { mode: "number" }).notNull(),
    authRevision: bigint("auth_revision", { mode: "number" }).notNull(),
    loginBindingRevision: bigint("login_binding_revision", { mode: "number" }).notNull(),
    displayName: text("display_name").notNull(),
    verifiedEmail: text("verified_email").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    idSet: unique("managed_auth_login_slots_id_set_unique").on(table.id, table.sessionSetId),
    liveBinding: uniqueIndex("managed_auth_login_slots_live_binding_idx")
      .on(table.sessionSetId, table.loginBindingId)
      .where(sql`${table.status} <> 'revoked'`),
    setStatus: index("managed_auth_login_slots_set_status_idx").on(
      table.sessionSetId,
      table.status,
      table.createdAt,
      table.id,
    ),
  }),
);

export const managedAuthLoginReturnIntents = pgTable("managed_auth_login_return_intents", {
  id: uuid("id").primaryKey(),
  sessionSetId: uuid("session_set_id").notNull(),
  path: text("path").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const managedAuthLoginTransactions = pgTable(
  "managed_auth_login_transactions",
  {
    id: uuid("id").primaryKey(),
    sessionSetId: uuid("session_set_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    kind: text("kind").notNull(),
    targetSlotId: uuid("target_slot_id"),
    expectedIdentityId: uuid("expected_identity_id"),
    expectedLoginBindingId: uuid("expected_login_binding_id"),
    expectedIdentityRevision: bigint("expected_identity_revision", { mode: "number" }),
    expectedAuthRevision: bigint("expected_auth_revision", { mode: "number" }),
    expectedLoginBindingRevision: bigint("expected_login_binding_revision", { mode: "number" }),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    returnIntentId: uuid("return_intent_id"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setStatus: index("managed_auth_login_transactions_set_status_idx").on(
      table.sessionSetId,
      table.status,
      table.expiresAt,
    ),
  }),
);

export const managedAuthSessionSetOperations = pgTable(
  "managed_auth_session_set_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    sessionSetId: uuid("session_set_id").notNull(),
    operationType: text("operation_type").notNull(),
    requestDigest: text("request_digest").notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    resultGeneration: bigint("result_generation", { mode: "number" }).notNull(),
    resultActorEpoch: bigint("result_actor_epoch", { mode: "number" }).notNull(),
    targetSlotId: uuid("target_slot_id"),
    replacementSlotId: uuid("replacement_slot_id"),
    outcome: text("outcome").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setCreated: index("managed_auth_session_set_operations_set_created_idx").on(
      table.sessionSetId,
      table.createdAt,
      table.operationId,
    ),
  }),
);

export const managedAuthActorMutationLeases = pgTable(
  "managed_auth_actor_mutation_leases",
  {
    sessionSetId: uuid("session_set_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorEpoch: bigint("actor_epoch", { mode: "number" }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.sessionSetId, table.requestId] }),
    expiry: index("managed_auth_actor_mutation_leases_expiry_idx").on(
      table.expiresAt,
      table.sessionSetId,
    ),
  }),
);
