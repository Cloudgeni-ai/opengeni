import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  customType,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(3072)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
});

export const managedAccounts = pgTable(
  "managed_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    external: uniqueIndex("managed_accounts_external_idx").on(
      table.externalSource,
      table.externalId,
    ),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    // White-label agent persona template override. NULL means the deployment
    // default (OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE / DEFAULT_AGENT_INSTRUCTIONS).
    agentInstructions: text("agent_instructions"),
    // Growth-ready per-workspace settings bag (migration 0045). Holds memoryEnabled
    // and future workspace-level toggles; validated/merged via WorkspaceSettingsSchema.
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    // The workspace's default rig (migration 0047). NULL ⇒ no default; sessions
    // created without an explicit rig ride no rig (today's behavior exactly). FK
    // (-> rigs(id) ON DELETE SET NULL) lives in migration 0047, not a Drizzle
    // .references(), because `rigs` is declared later in this file (same
    // forward-reference pattern as sessions.activeSandboxId). Consumed in M3.
    defaultRigId: uuid("default_rig_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    account: index("workspaces_account_idx").on(table.accountId),
    accountSlug: uniqueIndex("workspaces_account_slug_idx")
      .on(table.accountId, table.slug)
      .where(sql`${table.slug} is not null`),
    external: uniqueIndex("workspaces_external_idx").on(table.externalSource, table.externalId),
  }),
);

// One mandatory workspace-wide admission barrier. Every inference-admitting
// transaction locks this row before it touches a session; Pause/Resume and
// foreground Send/Steer advance its monotonic revision under FOR UPDATE.
export const workspaceInferenceControls = pgTable(
  "workspace_inference_controls",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    workspaceState: text("workspace_state").notNull().default("active"),
    workspacePauseRevision: bigint("workspace_pause_revision", { mode: "number" }),
    reason: text("reason"),
    changedBy: text("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "workspace_inference_controls_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceAccountIdentity: uniqueIndex("workspace_inference_controls_workspace_account_uq").on(
      table.workspaceId,
      table.accountId,
    ),
    stateValid: check(
      "workspace_inference_controls_state_check",
      sql`${table.workspaceState} in ('active', 'paused')`,
    ),
    pauseRevisionConsistent: check(
      "workspace_inference_controls_pause_revision_check",
      sql`(${table.workspaceState} = 'active' and ${table.workspacePauseRevision} is null)
        or (${table.workspaceState} = 'paused' and ${table.workspacePauseRevision} is not null)`,
    ),
    revisionValid: check(
      "workspace_inference_controls_revision_check",
      sql`${table.revision} >= 0 and (${table.workspacePauseRevision} is null or ${table.workspacePauseRevision} <= ${table.revision})`,
    ),
  }),
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    subjectLabel: text("subject_label"),
    role: text("role").notNull().default("member"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectWorkspace: uniqueIndex("workspace_memberships_subject_workspace_idx").on(
      table.subjectId,
      table.workspaceId,
    ),
    subject: index("workspace_memberships_subject_idx").on(table.subjectId),
    account: index("workspace_memberships_account_idx").on(table.accountId),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    prefix: index("api_keys_prefix_idx").on(table.prefix),
    hash: uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    account: index("api_keys_account_idx").on(table.accountId),
    workspace: index("api_keys_workspace_idx").on(table.workspaceId),
  }),
);

export const workspaceVariableSets = pgTable(
  "workspace_variable_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceName: uniqueIndex("workspace_variable_sets_workspace_name_idx").on(
      table.workspaceId,
      table.name,
    ),
    workspaceCreated: index("workspace_variable_sets_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export const workspaceVariableSetVariables = pgTable(
  "workspace_variable_set_variables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    variableSetId: uuid("variable_set_id")
      .notNull()
      .references(() => workspaceVariableSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Format: v1:<base64 iv>:<base64 ciphertext||gcm-tag>. Never returned by any API.
    valueEncrypted: text("value_encrypted").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    variableSetName: uniqueIndex("workspace_variable_set_variables_env_name_idx").on(
      table.workspaceId,
      table.variableSetId,
      table.name,
    ),
    variableSet: index("workspace_variable_set_variables_workspace_env_idx").on(
      table.workspaceId,
      table.variableSetId,
    ),
  }),
);

// Per-workspace ChatGPT/Codex subscription credential. One row per workspace.
// access/refresh/id tokens live INSIDE credential_encrypted (v1 AES-256-GCM,
// same envelope as workspace_variable_set_variables); the other columns are
// plaintext metadata (header value + UI). RLS-isolated per workspace.
export const codexSubscriptionCredentials = pgTable(
  "codex_subscription_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Format: v1:<base64 iv>:<base64 ciphertext||gcm-tag>. JSON {access_token, refresh_token, id_token}. Never returned by any API.
    credentialEncrypted: text("credential_encrypted").notNull(),
    chatgptAccountId: text("chatgpt_account_id"), // plaintext ChatGPT-Account-ID header value (non-secret)
    scopes: text("scopes"), // space-delimited, as granted
    planType: text("plan_type"),
    isFedramp: boolean("is_fedramp").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // derived from access-token JWT exp
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | needs_relogin | error
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    label: text("label"), // user-chosen nickname; null ⇒ derive from email/plan/account
    accountEmail: text("account_email"), // email from the id_token (user's own email; non-secret)
    // P2 usage cache (plaintext metadata; NEVER a token). Snapshotted from
    // GET /wham/usage; drives the quota bars + the cache TTL. primary = 5h window
    // (limit_window_seconds 18000), secondary = weekly (604800).
    primaryUsedPercent: integer("primary_used_percent"),
    primaryResetAt: timestamp("primary_reset_at", { withTimezone: true }),
    secondaryUsedPercent: integer("secondary_used_percent"),
    secondaryResetAt: timestamp("secondary_reset_at", { withTimezone: true }),
    usageCheckedAt: timestamp("usage_checked_at", { withTimezone: true }), // snapshot freshness → cache TTL clock
    // P3 rotation cooldown (plaintext metadata; NEVER a token). Set when this account hit its
    // usage cap on a rotation turn; the rotation engine treats `exhausted_until > now()` as
    // capped/skip so it isn't immediately re-picked. Self-clears via the now() comparison.
    exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
    // P4 connector-aware rotation cache (plaintext metadata; NEVER a token). The set
    // of ORIGINAL-dotted connector namespaces (github/gmail/linear/…) this account
    // exposes via codex_apps, captured from the per-turn tools/list. null ⇒ never
    // probed (the ranker treats it as unknown: never credited as covering, never
    // excluded). The writer only ever sets a NON-empty set, so a flaky empty turn
    // can't false-drop coverage. connectorsCheckedAt is the freshness clock.
    connectorNamespaces: text("connector_namespaces").array(),
    connectorsCheckedAt: timestamp("connectors_checked_at", { withTimezone: true }),
    // Workspace-local, server-held fairness cursor. Provider usage headers are
    // capacity hints, never the sole allocator: live lease count is ranked first
    // and this cursor deterministically breaks equal-load/equal-capacity ties.
    // This flag controls NEW automatic allocations only. Credential health,
    // refresh, encrypted material, and already-frozen/in-flight turns are
    // intentionally independent. OPE-24 owns toggle OCC/audit and product UI.
    allocatorEnabled: boolean("allocator_enabled").notNull().default(true),
    selectionCount: integer("selection_count").notNull().default(0),
    lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // REPLACES codex_subscription_credentials_workspace_idx (the one-per-workspace cap).
    // One row per (workspace, ChatGPT account). Partial WHERE chatgpt_account_id IS NOT NULL
    // so degenerate null-account rows can't collide; the device-grant connect path always
    // populates chatgpt_account_id.
    wsAccount: uniqueIndex("codex_subscription_credentials_ws_account_idx")
      .on(table.workspaceId, table.chatgptAccountId)
      .where(sql`${table.chatgptAccountId} is not null`),
    workspace: index("codex_subscription_credentials_workspace_lookup_idx").on(table.workspaceId),
    // Composite identity is the defense-in-depth FK target for workspace-local
    // lease references in migration 0053.
    workspaceIdentity: uniqueIndex("codex_subscription_credentials_workspace_id_idx").on(
      table.workspaceId,
      table.id,
    ),
  }),
);

// Generic external-service credential spine. credential_encrypted is the ONLY
// secret-bearing column; normal API reads use metadata-only helpers below the DB
// layer. Runtime token material is decrypted only by the broker accessor.
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id"),
    providerDomain: text("provider_domain").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    credentialEncrypted: text("credential_encrypted").notNull(),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBySubjectId: text("created_by_subject_id"),
    updatedBySubjectId: text("updated_by_subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderStatus: index("connections_workspace_provider_status_idx").on(
      table.workspaceId,
      table.providerDomain,
      table.status,
    ),
    workspaceSubjectProvider: index("connections_workspace_subject_provider_idx").on(
      table.workspaceId,
      table.subjectId,
      table.providerDomain,
    ),
    workspaceKind: index("connections_workspace_kind_idx").on(table.workspaceId, table.kind),
    workspaceExpires: index("connections_workspace_expires_idx").on(
      table.workspaceId,
      table.expiresAt,
    ),
  }),
);

// OAuth client registrations minted through MCP DCR, keyed by authorization
// server issuer. This is deployment-wide client identity, not a workspace
// credential; per-user/provider tokens still live only in connections.
export const integrationOauthClients = pgTable(
  "integration_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    authorizationServer: text("authorization_server").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: text("client_secret_encrypted"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuer: uniqueIndex("integration_oauth_clients_issuer_idx").on(table.issuer),
    authorizationServer: index("integration_oauth_clients_as_idx").on(table.authorizationServer),
  }),
);

// Consumed OAuth state nonces. Rows are inserted only on callback; the primary
// key makes a verified state single-use across API instances.
export const integrationOauthStateNonces = pgTable(
  "integration_oauth_state_nonces",
  {
    nonce: text("nonce").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: index("integration_oauth_state_nonces_workspace_idx").on(table.workspaceId),
    expires: index("integration_oauth_state_nonces_expires_idx").on(table.expiresAt),
  }),
);

// Per-workspace Codex account selection (the ACTIVE pointer) + P3 rotation
// forward-compat. One row per workspace. The only P1-load-bearing column is
// activeCredentialId — the account a session runs on when it has no pin. NULL ⇒
// none selected (e.g. the active one was just disconnected). The
// (account_id, workspace_id) pair inherits the verbatim workspace_rls_visible
// policy. active_credential_id's FK is declared in the MIGRATION (not
// .references()) to avoid a forward-reference on the const ordering, exactly like
// sessions.activeSandboxId; ON DELETE SET NULL.
export const codexRotationSettings = pgTable(
  "codex_rotation_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    activeCredentialId: uuid("active_credential_id"),
    // Legacy selector bit. Keep false as the DB default forever: an old worker
    // only understands this column, so a schema-first rollout or binary
    // rollback must never make it enter the non-atomic rotation path.
    rotationEnabled: boolean("rotation_enabled").notNull().default(false),
    // Revision-aware allocator cutover. Only migration-compatible API/worker
    // code reads this bit; old binaries safely ignore it and keep the legacy
    // pin/rotation policy.
    leaseRotationEnabled: boolean("lease_rotation_enabled").notNull().default(false),
    rotationStrategy: text("rotation_strategy").notNull().default("sharded"), // OPE-36: legacy residue; behavior is always sharded
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: uniqueIndex("codex_rotation_settings_workspace_idx").on(table.workspaceId),
  }),
);

// Per-workspace model/provider availability policy — the HARD blocker deciding
// which providers/models may serve a turn in this workspace AT ALL. NULL columns
// mean unrestricted (today's behavior for every workspace without a row). A
// non-null allowed_providers is a strict allowlist over provider identities
// (the same identities the model router resolves to, with the built-in
// OpenAI/Azure client — including the legacy resolveTurnModel-null fallback —
// mapped to one well-known id); a non-null allowed_models is an additional
// exact-model-id allowlist. Enforced at the API model-choke points (422) and,
// authoritatively, in the worker immediately after turn model resolution: a
// blocked resolution NEVER reaches a model call and NEVER silently remaps.
// This exists so a codex-subscription workspace can be fail-closed to codex —
// a turn can wait/fail loud, but can never fall through to the paid built-in.
export const workspaceModelPolicies = pgTable(
  "workspace_model_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    allowedProviders: text("allowed_providers").array(),
    allowedModels: text("allowed_models").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: uniqueIndex("workspace_model_policies_workspace_idx").on(table.workspaceId),
  }),
);

// One workspace-local short-lived holder per running Codex turn. Selection and
// insertion happen atomically while codex_rotation_settings is locked FOR
// UPDATE, so concurrent replicas in the SAME workspace see one another's
// assignments before choosing. Workspaces never share or correlate lease state.
// The composite (workspace, account), (workspace, credential), and
// (workspace, turn) FKs are declared in migration 0053 (sessionTurns is defined
// later in this module).
export const codexCredentialLeases = pgTable(
  "codex_credential_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    // Temporal activity execution fence. A successor dispatch for the same
    // durable turn replaces holderId and increments generation atomically;
    // stale/zombie heartbeats and releases must match both values.
    holderId: text("holder_id").notNull(),
    generation: integer("generation").notNull().default(1),
    leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    turn: uniqueIndex("codex_credential_leases_workspace_turn_idx").on(
      table.workspaceId,
      table.turnId,
    ),
    activeCredential: index("codex_credential_leases_active_credential_idx").on(
      table.workspaceId,
      table.credentialId,
      table.leasedUntil,
    ),
    expiry: index("codex_credential_leases_expiry_idx").on(table.leasedUntil),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    initialMessage: text("initial_message").notNull(),
    title: text("title"),
    titleSource: text("title_source"),
    // Per-session agent persona/system instructions supplied at create (the
    // per-agent-type prompt lever for embedding hosts). NULL ⇒ the session
    // carried none, so the composed agent instructions are byte-identical to a
    // workspace-only persona (no backfill, no behavior change for existing rows).
    // Composed system-level AFTER the workspace agentInstructions; never emitted
    // as a timeline event.
    instructions: text("instructions"),
    resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
    tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    model: text("model").notNull(),
    sandboxBackend: text("sandbox_backend").notNull(),
    // The OS this session's box runs. Defaults to 'linux' (today's only OS, so
    // every existing + new row is a behavior-preserving no-op). CHECK-constrained
    // to the SandboxOs enum (linux|macos|windows) in migration 0018.
    sandboxOs: text("sandbox_os").notNull().default("linux"),
    // The shared-sandbox group this session's box belongs to. Defaults to the
    // session's OWN id (a singleton group: group === session — today's 1:1
    // behavior). When spawned shared via session_create, set to the PARENT's
    // sandboxGroupId so both run in ONE box. Immutable once set. NOT an FK (the
    // value is this row's id or an ancestor session's id in the same workspace;
    // the live lease row, not a sandbox_groups table, materializes the group).
    // The app generates the uuid and uses it for both id and sandbox_group_id in
    // one insert — it cannot SQL-default to id (id is defaultRandom()).
    sandboxGroupId: uuid("sandbox_group_id").notNull(),
    // The first-class swappable-sandbox POINTER (bring-your-own-compute M2,
    // dossier §10.3). NULL == "use the session's own group sandbox" (the
    // backward-compat default — every existing/new row is a behavior-preserving
    // no-op). The routing proxy re-reads (active_sandbox_id, active_epoch) PER
    // TOOL CALL to make a Modal<->selfhosted hot-swap seamless. The FK
    // (-> sandboxes(id) ON DELETE SET NULL — a deleted sandbox degrades the
    // pointer to the group default, never dangles) lives in migration 0024, NOT a
    // Drizzle .references() — exactly like parentSessionId below, so the const
    // ordering imposes no forward-reference.
    activeSandboxId: uuid("active_sandbox_id"),
    // The SECOND epoch ABOVE sandbox_leases.lease_epoch, bumped on every swap; an
    // in-flight op fenced by a stale active_epoch retries against the new active
    // sandbox. integer (NOT bigint) — the lease-epoch spike: int8 reads back as a
    // JS string and breaks the strict fence; int4 returns a number.
    activeEpoch: integer("active_epoch").notNull().default(0),
    // The session's WORKING DIRECTORY — the path/cwd base the (selfhosted) box's
    // agent/terminal/file-dock operate under. A launch-workspace_root-relative
    // subdir or an absolute machine path; surfaced alongside the active-sandbox
    // pointer (readActiveSandbox) and written through the epoch-fenced
    // setActiveSandbox CAS, NOT the row INSERT. NULL (the default) ⇒ today's
    // behavior exactly — the agent substitutes its workspace_root for an empty cwd,
    // so an unset working_dir is a byte-identical no-op. Create-time only (Stage A).
    workingDir: text("working_dir"),
    variableSetId: uuid("variable_set_id").references(() => workspaceVariableSets.id, {
      onDelete: "set null",
    }),
    // The rig this session rides + the exact rig version frozen at create time
    // (migration 0047). NULL ⇒ the session rides no rig (today's behavior). FKs
    // (-> rigs(id)/rig_versions(id) ON DELETE SET NULL) live in migration 0047,
    // not Drizzle .references(), because those tables are declared later in this
    // file (forward-reference pattern, same as activeSandboxId). Consumed in M3.
    rigId: uuid("rig_id"),
    rigVersionId: uuid("rig_version_id"),
    // Provenance fence for rig default variable-set decryption (migration
    // 0066). Missing/false legacy rows may keep using secret-free rigs, but the
    // worker refuses to decrypt defaults for them.
    rigDefaultVariableSetsAuthorized: boolean("rig_default_variable_sets_authorized")
      .notNull()
      .default(false),
    // Non-default first-party MCP token permissions (manager-style sessions);
    // null means the fixed worker default set in @opengeni/runtime.
    firstPartyMcpPermissions: jsonb("first_party_mcp_permissions").$type<string[]>(),
    // The manager session that spawned this one via session_create. Set only
    // when the creating grant carried a worker-signed sessionId claim (a session
    // spawning a worker); null for direct API creates and scheduled-task runs.
    // When set, this worker's terminal-for-now transitions wake the parent so a
    // manager can orchestrate workers without busy-polling. Self-referencing FK,
    // ON DELETE SET NULL so deleting a manager never cascades into its workers.
    parentSessionId: uuid("parent_session_id"),
    // Workspace-scoped CREATE idempotency key. NULL means the create carried no
    // key (each such create is independent). When set, the partial unique index
    // below collapses concurrent/retried creates with the same key in the same
    // workspace to a single session row — the dedup that closes the
    // double-submit/double-dispatch stuck-queued bug.
    createIdempotencyKey: text("create_idempotency_key"),
    temporalWorkflowId: text("temporal_workflow_id"),
    activeTurnId: uuid("active_turn_id"),
    // Actual input tokens reported for the last model call of the most recent
    // turn. The pre-turn portable compaction trigger reads this as its budget
    // signal (char/4 estimate is the same-turn fallback). Null until a turn with
    // usage has completed.
    lastInputTokens: integer("last_input_tokens"),
    // Operator /compact request flag. The API sets
    // it true; the worker honors it BEFORE the next turn's model call by forcing
    // a compaction, then clears it. A durable flag (not a transient signal) so
    // the trigger survives a worker restart and converges before the next turn.
    compactRequested: boolean("compact_requested").notNull().default(false),
    queueVersion: integer("queue_version").notNull().default(0),
    queueHeadPosition: bigint("queue_head_position", { mode: "number" }).notNull().default(0),
    queueTailPosition: bigint("queue_tail_position", { mode: "number" }).notNull().default(0),
    directControlState: text("direct_control_state").notNull().default("active"),
    directPauseRevision: bigint("direct_pause_revision", { mode: "number" }),
    subtreeRunOverrideRevision: bigint("subtree_run_override_revision", { mode: "number" }),
    controlVersion: bigint("control_version", { mode: "number" }).notNull().default(0),
    directControlReason: text("direct_control_reason"),
    directControlChangedBy: text("direct_control_changed_by"),
    directControlChangedAt: timestamp("direct_control_changed_at", { withTimezone: true }),
    lastSequence: integer("last_sequence").notNull().default(0),
    // The session's PINNED Codex account (manual override from the in-session
    // switcher). NULL ⇒ follow the workspace active pointer. FK declared in the
    // migration with ON DELETE SET NULL (a disconnected pin degrades to "follow
    // active", never dangles), same pattern as activeSandboxId.
    codexPinnedCredentialId: uuid("codex_pinned_credential_id"),
    // The Codex account the session's most recent turn ACTUALLY ran on — drives
    // the "Running on:" indicator. Written by the worker at the turn boundary. FK
    // ON DELETE SET NULL (migration).
    codexLastCredentialId: uuid("codex_last_credential_id"),
    // The SOURCE of codex_pinned_credential_id (AM-2): 'manual' — the user's
    // in-session account switcher, which is SACRED and never moved by any policy —
    // or 'policy' — the sharded rotation strategy's deterministic per-session home
    // assignment, which MAY be re-sharded to another account when its own account
    // caps. NULL when there is no pin (and for every pre-existing row). CHECK
    // (manual|policy) lives in the migration; no FK (it describes the pin, not an
    // account).
    codexPinSource: text("codex_pin_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("sessions_workspace_id_idx").on(table.workspaceId, table.id),
    workspaceCreated: index("sessions_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    variableSet: index("sessions_variable_set_idx").on(table.workspaceId, table.variableSetId),
    parent: index("sessions_parent_idx").on(table.workspaceId, table.parentSessionId),
    // Routing index: resolve session_id -> sandbox_group_id at every lease entry
    // point and enumerate all sessions in a group for attribution/disclosure.
    sandboxGroup: index("sessions_sandbox_group_idx").on(table.workspaceId, table.sandboxGroupId),
    // Partial unique index: one session per (workspace, create_idempotency_key)
    // when a key is present. Concurrent creates racing on the same key see a
    // unique violation on all but one; the domain layer catches it and returns
    // the winning row instead of erroring.
    createIdempotency: uniqueIndex("sessions_workspace_create_idempotency_idx")
      .on(table.workspaceId, table.createIdempotencyKey)
      .where(sql`${table.createIdempotencyKey} is not null`),
  }),
);

// Per-authenticated-subject session organization. This is deliberately a
// relation instead of a session column: one member's pin must never reorder a
// shared workspace for another member, and a session's own activity timestamps
// must remain agent/runtime truth. `subjectId` is the trusted AccessGrant
// subject, which is text because configured/delegated principals are not always
// UUIDs. The account/workspace pair carries the standard forced-RLS boundary.
export const sessionPins = pgTable(
  "session_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // Keep an unpinned tombstone (pinned=false, pinned_at=null) rather than
    // deleting it. That preserves a monotonic version and prevents an ABA race:
    // a stale client that saw pin version 1 cannot silently overwrite a later
    // unpin+re-pin that would otherwise recreate version 1.
    pinned: boolean("pinned").notNull().default(true),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => ({
    subjectNonempty: check(
      "session_pins_subject_nonempty",
      sql`length(btrim(${table.subjectId})) > 0`,
    ),
    versionPositive: check("session_pins_version_positive", sql`${table.version} >= 1`),
    stateConsistent: check(
      "session_pins_state_consistent",
      sql`((${table.pinned}) and (${table.pinnedAt}) is not null) or ((not ${table.pinned}) and (${table.pinnedAt}) is null)`,
    ),
    workspaceAccount: foreignKey({
      name: "session_pins_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceSession: foreignKey({
      name: "session_pins_workspace_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    subjectSession: uniqueIndex("session_pins_subject_workspace_session_idx").on(
      table.subjectId,
      table.workspaceId,
      table.sessionId,
    ),
    subjectPinned: index("session_pins_workspace_subject_pinned_idx").on(
      table.workspaceId,
      table.subjectId,
      table.pinned,
      table.pinnedAt.desc(),
      table.sessionId.desc(),
    ),
  }),
);

// A short-lived server-owned continuation snapshot for the pin-aware session
// list. The ordinary list is ordered by mutable activity, so a cursor cannot
// safely replay that order from updated_at alone across HTTP requests. The
// snapshot stores the already-ordered ordinary ids; the list query still joins
// live session rows for current lifecycle/title data and expires snapshots
// opportunistically.
export const sessionListSnapshots = pgTable(
  "session_list_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectId: text("subject_id").notNull(),
    parentSessionFilter: text("parent_session_filter").notNull().default("all"),
    search: text("search"),
    ordinarySessionIds: uuid("ordinary_session_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "session_list_snapshots_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    subjectNonempty: check(
      "session_list_snapshots_subject_nonempty",
      sql`length(btrim(${table.subjectId})) > 0`,
    ),
    parentFilterValid: check(
      "session_list_snapshots_parent_filter_valid",
      sql`${table.parentSessionFilter} = 'all' or ${table.parentSessionFilter} = 'null' or ${table.parentSessionFilter} ~ '^[0-9a-fA-F-]{36}$'`,
    ),
    searchLength: check(
      "session_list_snapshots_search_length",
      sql`${table.search} is null or length(${table.search}) <= 200`,
    ),
    workspaceExpiry: index("session_list_snapshots_workspace_expiry_idx").on(
      table.workspaceId,
      table.subjectId,
      table.expiresAt,
    ),
    expiryReaper: index("session_list_snapshots_expiry_reaper_idx").on(table.expiresAt, table.id),
  }),
);

export const sessionMcpServers = pgTable(
  "session_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    name: text("name"),
    url: text("url").notNull(),
    allowedTools: jsonb("allowed_tools").$type<string[]>(),
    timeoutMs: integer("timeout_ms"),
    cacheToolsList: boolean("cache_tools_list").notNull().default(false),
    // Human-approval policy: `true` = every tool requires approval, a string[] of
    // UNPREFIXED tool names = only those require it, null/absent = auto-run.
    requireApproval: jsonb("require_approval").$type<boolean | string[]>(),
    // Map of header name -> AES-GCM ciphertext. Values are decrypted only by the
    // worker's run-preparation path and never returned by API helpers.
    headersEncrypted: jsonb("headers_encrypted")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    credentialVersion: integer("credential_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionServer: uniqueIndex("session_mcp_servers_session_server_idx").on(
      table.workspaceId,
      table.sessionId,
      table.serverId,
    ),
    session: index("session_mcp_servers_session_idx").on(table.workspaceId, table.sessionId),
  }),
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending_upload"),
    filename: text("filename").notNull(),
    safeFilename: text("safe_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreated: index("files_workspace_created_idx").on(table.workspaceId, table.createdAt),
    objectKey: uniqueIndex("files_object_key_idx").on(table.objectKey),
    status: index("files_status_idx").on(table.status),
  }),
);

export const fileUploads = pgTable(
  "file_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: index("file_uploads_workspace_idx").on(table.workspaceId),
    fileId: index("file_uploads_file_id_idx").on(table.fileId),
    status: index("file_uploads_status_idx").on(table.status),
  }),
);

export const documentBases = pgTable(
  "document_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreated: index("document_bases_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    baseId: uuid("base_id")
      .notNull()
      .references(() => documentBases.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("queued"),
    title: text("title").notNull(),
    parser: text("parser").notNull().default("liteparse"),
    chunkCount: integer("chunk_count").notNull().default(0),
    error: text("error"),
    sourceKind: text("source_kind").notNull().default("manual_upload"),
    sourceUri: text("source_uri"),
    sourceExternalId: text("source_external_id"),
    sourceTitle: text("source_title"),
    sourceAuthor: text("source_author"),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    sourceVersion: text("source_version"),
    aclTags: jsonb("acl_tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    baseFile: uniqueIndex("documents_workspace_base_file_idx").on(
      table.workspaceId,
      table.baseId,
      table.fileId,
    ),
    baseStatus: index("documents_workspace_base_status_idx").on(
      table.workspaceId,
      table.baseId,
      table.status,
    ),
    sourceKind: index("documents_workspace_source_kind_idx").on(
      table.workspaceId,
      table.sourceKind,
    ),
    sourceExternalId: index("documents_workspace_source_external_id_idx").on(
      table.workspaceId,
      table.sourceExternalId,
    ),
  }),
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    baseId: uuid("base_id")
      .notNull()
      .references(() => documentBases.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    embedding: vector("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIndex: uniqueIndex("document_chunks_workspace_document_index_idx").on(
      table.workspaceId,
      table.documentId,
      table.chunkIndex,
    ),
    base: index("document_chunks_workspace_base_idx").on(table.workspaceId, table.baseId),
  }),
);

export const knowledgeMemories = pgTable(
  "knowledge_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("proposed"),
    kind: text("kind").notNull().default("semantic"),
    scope: text("scope").notNull().default("workspace"),
    text: text("text").notNull(),
    sourceRefs: jsonb("source_refs").$type<unknown[]>().notNull().default([]),
    confidence: integer("confidence").notNull().default(50),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBySessionId: uuid("created_by_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Workspace Memory V1 (migration 0045). Embedding is nullable: fail-soft writes
    // (embedder unavailable) persist keyword-searchable rows without a vector.
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    pinned: boolean("pinned").notNull().default(false),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Self-referential supersession chain. FKs live in migration 0045 (ON DELETE SET
    // NULL); declared here as plain columns like the migration-only composite FK.
    supersedesId: uuid("supersedes_id"),
    supersededById: uuid("superseded_by_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    // sha256(normalizeMemoryText(text)) — exact-dedup key; see memory-domain.
    textHash: text("text_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceStatus: index("knowledge_memories_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
    workspaceKind: index("knowledge_memories_workspace_kind_idx").on(table.workspaceId, table.kind),
    workspaceScope: index("knowledge_memories_workspace_scope_idx").on(
      table.workspaceId,
      table.scope,
    ),
    createdBySession: index("knowledge_memories_workspace_created_by_session_idx").on(
      table.workspaceId,
      table.createdBySessionId,
    ),
    // Working-set selection (partial index mirrors migration 0045).
    workspaceVisible: index("knowledge_memories_workspace_visible_idx")
      .on(table.workspaceId, table.pinned, table.updatedAt)
      .where(sql`${table.status} in ('active', 'approved')`),
    workspaceTextHash: index("knowledge_memories_workspace_text_hash_idx").on(
      table.workspaceId,
      table.textHash,
    ),
    workspaceVisibleTextHashUnique: uniqueIndex("knowledge_memories_workspace_visible_text_hash_uq")
      .on(table.workspaceId, table.textHash)
      .where(sql`${table.status} in ('active', 'approved') and ${table.textHash} is not null`),
  }),
);

export const sessionTurns = pgTable(
  "session_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    triggerEventId: uuid("trigger_event_id").notNull(),
    temporalWorkflowId: text("temporal_workflow_id").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull().default("user"),
    position: bigint("position", { mode: "number" }).notNull(),
    prompt: text("prompt").notNull(),
    resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
    tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    sandboxBackend: text("sandbox_backend").notNull(),
    // Per-turn OS override. NULL = inherit the session's sandbox_os. CHECK-
    // constrained to the SandboxOs enum (or NULL) in migration 0018.
    sandboxOs: text("sandbox_os"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    executionGeneration: integer("execution_generation").notNull().default(0),
    // Composite FK to session_turn_attempts is installed by migration 0063.
    // It lives in SQL because attempts carry the reciprocal turn FK and because
    // the claim transaction preallocates this ID before inserting the attempt;
    // the SQL constraint is therefore DEFERRABLE INITIALLY DEFERRED.
    activeAttemptId: uuid("active_attempt_id"),
    lineage: jsonb("lineage").$type<Record<string, unknown>>().notNull().default({}),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
    // Atomic per-turn toolspace call budget counter (migration 0043). Incremented
    // by a single conditional UPDATE at tools/call time; the row lock serializes
    // concurrent reservations so exactly `toolspaceMaxCallsPerTurn` succeed.
    toolspaceCallCount: integer("toolspace_call_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("session_turns_workspace_id_idx").on(
      table.workspaceId,
      table.id,
    ),
    queue: index("session_turns_workspace_queue_idx").on(
      table.workspaceId,
      table.sessionId,
      table.status,
      table.position,
    ),
    oneCurrentInference: uniqueIndex("session_turns_one_current_inference_uq")
      .on(table.workspaceId, table.sessionId)
      .where(sql`${table.status} in ('running','requires_action','recovering','waiting_capacity')`),
  }),
);

// First-class ownership for one accepted execution attempt. A workflow may
// preallocate id, but this row is inserted only by the activity transaction
// that actually claims the logical turn and registers its exact dispatch.
export const sessionTurnAttempts = pgTable(
  "session_turn_attempts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    state: text("state").notNull().default("claimed"),
    outcome: text("outcome"),
    temporalWorkflowId: text("temporal_workflow_id").notNull(),
    temporalWorkflowRunId: text("temporal_workflow_run_id").notNull(),
    temporalActivityId: text("temporal_activity_id").notNull(),
    workerId: text("worker_id"),
    leaseId: text("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    verifiedControlRevision: bigint("verified_control_revision", { mode: "number" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "session_turn_attempts_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceSession: foreignKey({
      name: "session_turn_attempts_workspace_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("restrict"),
    workspaceTurn: foreignKey({
      name: "session_turn_attempts_workspace_turn_fk",
      columns: [table.workspaceId, table.turnId],
      foreignColumns: [sessionTurns.workspaceId, sessionTurns.id],
    }).onDelete("restrict"),
    workspaceIdentity: uniqueIndex("session_turn_attempts_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    liveTurn: uniqueIndex("session_turn_attempts_live_turn_uq")
      .on(table.workspaceId, table.turnId)
      .where(sql`${table.state} in ('claimed', 'running')`),
    liveSession: uniqueIndex("session_turn_attempts_live_session_uq")
      .on(table.workspaceId, table.sessionId)
      .where(sql`${table.state} in ('claimed', 'running')`),
    dispatch: uniqueIndex("session_turn_attempts_dispatch_uq").on(
      table.workspaceId,
      table.temporalWorkflowRunId,
      table.temporalActivityId,
    ),
    leaseExpiry: index("session_turn_attempts_lease_expiry_idx")
      .on(table.leaseExpiresAt, table.workspaceId, table.sessionId)
      .where(sql`${table.state} in ('claimed', 'running')`),
    stateValid: check(
      "session_turn_attempts_state_check",
      sql`${table.state} in ('claimed', 'running', 'closed')`,
    ),
    outcomeValid: check(
      "session_turn_attempts_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in (
        'completed', 'failed', 'cancelled', 'superseded', 'requires_action',
        'interrupted_recoverable', 'lease_lost_recoverable', 'pre_cutover_closed'
      )`,
    ),
    closedConsistent: check(
      "session_turn_attempts_closed_check",
      sql`(${table.state} = 'closed' and ${table.outcome} is not null and ${table.closedAt} is not null)
        or (${table.state} <> 'closed' and ${table.outcome} is null and ${table.closedAt} is null)`,
    ),
  }),
);

// One durable idempotency/operation record for every queue, control,
// foreground Send/Steer, and Agent MCP mutation. The database migration owns
// the NULLS NOT DISTINCT uniqueness form because Drizzle does not model it.
export const sessionCommandReceipts = pgTable(
  "session_command_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorSubjectId: text("actor_subject_id"),
    actorAttemptId: uuid("actor_attempt_id"),
    action: text("action").notNull(),
    targetSessionId: uuid("target_session_id"),
    targetTurnId: uuid("target_turn_id"),
    operationKey: text("operation_key").notNull(),
    canonicalRequestHash: text("canonical_request_hash").notNull(),
    appliedControlRevision: bigint("applied_control_revision", { mode: "number" }),
    appliedQueueVersion: integer("applied_queue_version"),
    appliedTurnVersion: integer("applied_turn_version"),
    appliedDraftRevision: bigint("applied_draft_revision", { mode: "number" }),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "session_command_receipts_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    actorAttempt: foreignKey({
      name: "session_command_receipts_actor_attempt_fk",
      columns: [table.workspaceId, table.actorAttemptId],
      foreignColumns: [sessionTurnAttempts.workspaceId, sessionTurnAttempts.id],
    }).onDelete("restrict"),
    targetSession: foreignKey({
      name: "session_command_receipts_target_session_fk",
      columns: [table.workspaceId, table.targetSessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("restrict"),
    targetTurn: foreignKey({
      name: "session_command_receipts_target_turn_fk",
      columns: [table.workspaceId, table.targetTurnId],
      foreignColumns: [sessionTurns.workspaceId, sessionTurns.id],
    }).onDelete("restrict"),
    workspaceIdentity: uniqueIndex("session_command_receipts_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    targetCreated: index("session_command_receipts_target_created_idx").on(
      table.workspaceId,
      table.targetSessionId,
      table.createdAt,
    ),
    actorValid: check(
      "session_command_receipts_actor_check",
      sql`(
        ${table.actorType} = 'agent_attempt'
        and ${table.actorAttemptId} is not null
        and ${table.actorSubjectId} is null
      ) or (
        ${table.actorType} in ('human', 'operator')
        and ${table.actorSubjectId} is not null
        and ${table.actorAttemptId} is null
      )`,
    ),
  }),
);

// One workspace-scoped durable invalidation per committed control revision.
// This is deliberately separate from conversation/session events: a parent or
// workspace Pause can change thousands of effective projections without
// manufacturing one event (or queue row) per descendant.
export const workspaceControlEvents = pgTable(
  "workspace_control_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    scope: text("scope").notNull(),
    rootSessionId: uuid("root_session_id"),
    action: text("action").notNull(),
    automatic: boolean("automatic").notNull().default(false),
    reason: text("reason"),
    actor: text("actor").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "workspace_control_events_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    rootSession: foreignKey({
      name: "workspace_control_events_root_session_fk",
      columns: [table.workspaceId, table.rootSessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("restrict"),
    workspaceRevision: uniqueIndex("workspace_control_events_workspace_revision_uq").on(
      table.workspaceId,
      table.revision,
    ),
    revisionValid: check("workspace_control_events_revision_check", sql`${table.revision} > 0`),
    shapeValid: check(
      "workspace_control_events_shape_check",
      sql`(${table.scope} = 'workspace' and ${table.rootSessionId} is null)
        or (${table.scope} = 'session' and ${table.rootSessionId} is not null)`,
    ),
    actionValid: check(
      "workspace_control_events_action_check",
      sql`${table.action} in ('pause', 'resume')`,
    ),
  }),
);

// An interruption is an independently durable request against an exact live
// attempt. Multiple Pause/Steer causes coexist; no scalar session field owns
// delivery or settlement.
export const sessionAttemptInterruptions = pgTable(
  "session_attempt_interruptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    kind: text("kind").notNull(),
    controlRevision: bigint("control_revision", { mode: "number" }).notNull(),
    state: text("state").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "session_attempt_interruptions_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceSession: foreignKey({
      name: "session_attempt_interruptions_workspace_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("restrict"),
    operation: foreignKey({
      name: "session_attempt_interruptions_operation_fk",
      columns: [table.workspaceId, table.operationId],
      foreignColumns: [sessionCommandReceipts.workspaceId, sessionCommandReceipts.id],
    }).onDelete("restrict"),
    attempt: foreignKey({
      name: "session_attempt_interruptions_attempt_fk",
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [sessionTurnAttempts.workspaceId, sessionTurnAttempts.id],
    }).onDelete("restrict"),
    operationAttempt: uniqueIndex("session_attempt_interruptions_operation_attempt_uq").on(
      table.operationId,
      table.attemptId,
    ),
    unsettled: index("session_attempt_interruptions_unsettled_idx")
      .on(table.workspaceId, table.sessionId, table.requestedAt)
      .where(sql`${table.state} in ('pending', 'delivered', 'acknowledged')`),
    kindValid: check(
      "session_attempt_interruptions_kind_check",
      sql`${table.kind} in ('session_pause', 'workspace_pause', 'steer', 'maintenance')`,
    ),
    stateValid: check(
      "session_attempt_interruptions_state_check",
      sql`${table.state} in ('pending', 'delivered', 'acknowledged', 'settled', 'rejected_stale')`,
    ),
  }),
);

// Private, authenticated-subject composer truth. Editing a queued prompt and
// restoring it here is one transaction; human drafts are never agent-visible.
export const composerDrafts = pgTable(
  "composer_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    subjectId: text("subject_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    text: text("text").notNull().default(""),
    resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
    tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    sourceTurnId: uuid("source_turn_id"),
    sourceTurnVersion: integer("source_turn_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "composer_drafts_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceSession: foreignKey({
      name: "composer_drafts_workspace_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    sourceTurn: foreignKey({
      name: "composer_drafts_source_turn_fk",
      columns: [table.workspaceId, table.sourceTurnId],
      foreignColumns: [sessionTurns.workspaceId, sessionTurns.id],
    }).onDelete("restrict"),
    subjectSession: uniqueIndex("composer_drafts_subject_session_uq").on(
      table.workspaceId,
      table.sessionId,
      table.subjectId,
    ),
    subjectValid: check(
      "composer_drafts_subject_check",
      sql`length(btrim(${table.subjectId})) > 0`,
    ),
    revisionValid: check("composer_drafts_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const sessionSystemUpdates = pgTable(
  "session_system_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    classification: text("classification").notNull().default("info"),
    sourceId: text("source_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    lineage: jsonb("lineage").$type<Record<string, unknown>>().notNull().default({}),
    // pending: eligible to start/attach to an inference; deferred: preserved
    // after a failed internal-only inference but dormant until a real prompt or
    // a genuinely new pending update arrives; delivered/cancelled/failed are
    // terminal for that delivery attempt.
    state: text("state").notNull().default("pending"),
    deliveredTurnId: uuid("delivered_turn_id").references(() => sessionTurns.id, {
      onDelete: "set null",
    }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindValid: check(
      "system_updates_kind_check",
      sql`${table.kind} in ('scheduled_occurrence', 'goal_continuation', 'agent_message', 'agent_steer_instruction', 'child_terminal_result')`,
    ),
    payloadKindValid: check(
      "system_updates_payload_kind_check",
      sql`${table.payload} ->> 'type' = ${table.kind}`,
    ),
    stateValid: check(
      "system_updates_state_check",
      sql`${table.state} in ('pending', 'deferred', 'delivered', 'cancelled', 'superseded', 'failed')`,
    ),
    dedupe: uniqueIndex("session_system_updates_dedupe_uq").on(
      table.workspaceId,
      table.sessionId,
      table.dedupeKey,
    ),
    pending: index("session_system_updates_pending_idx").on(
      table.workspaceId,
      table.sessionId,
      table.state,
      table.createdAt,
    ),
  }),
);

/**
 * Durable child-terminal producer outbox. The source terminal transaction
 * inserts this row; fan-in delivery marks it delivered inside
 * addSessionSystemUpdateWithSourceMutation. A bounded reconciler may retry a
 * committed row after any worker/process death without duplicating a member.
 */
export const sessionSystemUpdateOutbox = pgTable(
  "session_system_update_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    targetSessionId: uuid("target_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").notNull(),
    classification: text("classification").notNull(),
    sourceId: text("source_id").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    lineage: jsonb("lineage").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    updateId: uuid("update_id"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindValid: check(
      "system_update_outbox_kind_check",
      sql`${table.kind} = 'child_terminal_result'`,
    ),
    payloadKindValid: check(
      "system_update_outbox_payload_kind_check",
      sql`${table.payload} ->> 'type' = 'child_terminal_result'`,
    ),
    dedupe: uniqueIndex("session_system_update_outbox_dedupe_uq").on(
      table.workspaceId,
      table.dedupeKey,
    ),
    pending: index("session_system_update_outbox_pending_idx").on(table.status, table.createdAt),
  }),
);

/**
 * Transactional delivery ledger for session-workflow wakeups. Postgres owns
 * work eligibility; Temporal signals are only nudges. One coalescing row per
 * session makes a committed mutation repairable without periodically scanning
 * every session that happens to look runnable.
 */
export const sessionWorkflowWakeOutbox = pgTable(
  "session_workflow_wake_outbox",
  {
    sessionId: uuid("session_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    temporalWorkflowId: text("temporal_workflow_id").notNull(),
    wakeRevision: bigint("wake_revision", { mode: "number" }).notNull().default(1),
    deliveredRevision: bigint("delivered_revision", { mode: "number" }).notNull().default(0),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionValid: check(
      "session_workflow_wake_outbox_revision_check",
      sql`${table.wakeRevision} > 0 and ${table.deliveredRevision} >= 0 and ${table.deliveredRevision} <= ${table.wakeRevision}`,
    ),
    workspaceAccount: foreignKey({
      name: "session_workflow_wake_outbox_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("cascade"),
    workspaceSessionFk: foreignKey({
      name: "session_workflow_wake_outbox_workspace_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    workspaceSession: uniqueIndex("session_workflow_wake_outbox_workspace_session_uq").on(
      table.workspaceId,
      table.sessionId,
    ),
    pending: index("session_workflow_wake_outbox_pending_idx")
      .on(table.nextAttemptAt, table.updatedAt, table.sessionId)
      .where(sql`${table.wakeRevision} > ${table.deliveredRevision}`),
  }),
);

export const sessionGoals = pgTable(
  "session_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active | paused | completed
    text: text("text").notNull(),
    successCriteria: text("success_criteria"),
    evidence: text("evidence"), // set by goal_complete
    rationale: text("rationale"), // set by goal_pause
    pausedReason: text("paused_reason"), // agent | user_pause | api | no_progress | max_auto_continuations | limits
    createdBy: text("created_by").notNull().default("api"), // api | agent | scheduled_task
    version: integer("version").notNull().default(1), // bumped on every set/update; progress signal
    autoContinuations: integer("auto_continuations").notNull().default(0),
    noProgressStreak: integer("no_progress_streak").notNull().default(0),
    maxAutoContinuations: integer("max_auto_continuations"), // per-goal override; a configured settings cap (if any) remains the hard ceiling
    lastContinuationTurnId: uuid("last_continuation_turn_id"),
    versionAtLastContinuation: integer("version_at_last_continuation"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("session_goals_workspace_id_idx").on(
      table.workspaceId,
      table.id,
    ),
    workspaceSession: uniqueIndex("session_goals_workspace_session_idx").on(
      table.workspaceId,
      table.sessionId,
    ),
    status: index("session_goals_workspace_status_idx").on(table.workspaceId, table.status),
  }),
);

// OPE-21: one durable, coalescing capacity waiter per session. The row is both
// the wait state and the commit->signal outbox: capacity mutations increment
// wakeRevision in the SAME transaction as the mutation, while the session
// workflow advances observedWakeRevision only after it has re-evaluated the
// allocator. Temporal signals are therefore repairable nudges rather than the
// source of truth. No credential material or provider response is stored here.
//
// The session/goal/turn foreign keys are declared in migration 0053 so the
// table keeps the same composite workspace-integrity posture as credential
// leases. Control is evaluated independently at admission and never changes a
// capacity waiter's identity. OPE-32 supplies policyHash when accepted-turn
// pool routing lands.
export const codexCapacityWaiters = pgTable(
  "codex_capacity_waiters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    blockedTurnId: uuid("blocked_turn_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("waiting"), // waiting | resumed | superseded
    goalVersion: integer("goal_version").notNull(),
    policyHash: text("policy_hash"),
    earliestResetAt: timestamp("earliest_reset_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    resetKind: text("reset_kind").notNull(), // authoritative | bounded_refresh
    refreshAttempt: integer("refresh_attempt").notNull().default(0),
    // Coalescing outbox generation. Every eligibility-affecting mutation bumps
    // wakeRevision. Duplicate/lost Temporal signals are harmless because only
    // the row-locked evaluator moves observedWakeRevision and may enqueue work.
    wakeRevision: integer("wake_revision").notNull().default(1),
    observedWakeRevision: integer("observed_wake_revision").notNull().default(0),
    lastWakeReason: text("last_wake_reason").notNull().default("capacity_wait_armed"),
    resumedUpdateId: uuid("resumed_update_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSession: uniqueIndex("codex_capacity_waiters_workspace_session_idx").on(
      table.workspaceId,
      table.sessionId,
    ),
    workspaceId: uniqueIndex("codex_capacity_waiters_workspace_id_idx").on(
      table.workspaceId,
      table.id,
    ),
    pending: index("codex_capacity_waiters_pending_idx").on(
      table.workspaceId,
      table.status,
      table.nextCheckAt,
    ),
    wakeRepair: index("codex_capacity_waiters_wake_repair_idx").on(
      table.status,
      table.wakeRevision,
      table.observedWakeRevision,
    ),
  }),
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id"),
    turnGeneration: integer("turn_generation"),
    turnAttemptId: uuid("turn_attempt_id"),
    turnAssociation: text("turn_association"),
    duplicateOfEventId: uuid("duplicate_of_event_id"),
    duplicateReason: text("duplicate_reason"),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    clientEventId: text("client_event_id"),
    producerId: text("producer_id"),
    producerSeq: integer("producer_seq"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAttempt: foreignKey({
      name: "session_events_workspace_attempt_fk",
      columns: [table.workspaceId, table.turnAttemptId],
      foreignColumns: [sessionTurnAttempts.workspaceId, sessionTurnAttempts.id],
    }).onDelete("restrict"),
    sessionSequence: uniqueIndex("session_events_workspace_session_sequence_idx").on(
      table.workspaceId,
      table.sessionId,
      table.sequence,
    ),
    clientEvent: uniqueIndex("session_events_workspace_client_event_idx")
      .on(table.workspaceId, table.sessionId, table.clientEventId)
      .where(sql`${table.clientEventId} is not null`),
    producer: uniqueIndex("session_events_workspace_producer_idx")
      .on(table.workspaceId, table.sessionId, table.producerId, table.producerSeq)
      .where(sql`${table.producerId} is not null and ${table.producerSeq} is not null`),
    sessionCreated: index("session_events_workspace_session_created_idx").on(
      table.workspaceId,
      table.sessionId,
      table.createdAt,
    ),
  }),
);

export const agentRunStates = pgTable("agent_run_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
  stateVersion: integer("state_version").notNull(),
  serializedRunState: text("serialized_run_state").notNull(),
  pendingApprovals: jsonb("pending_approvals").$type<unknown[]>().notNull().default([]),
  // The Codex account that FROZE this run state: the turn's resolved codex
  // credential id (pin > workspace-active), or NULL when frozen on the
  // non-codex / Azure path (or before this column existed). The serialized
  // RunState blob round-trips `reasoning.encrypted_content` minted by the
  // ChatGPT/Codex backend — account/org-bound, so a foreign blob 400s — and the
  // foreign reasoning ids the Responses backend validates; but the blob carries
  // NO per-item producer tag (those live only on session_history_items). So we
  // stamp the freezing account here: on an approval resume whose codex account
  // DIFFERS from this value,
  // the replay path neutralizes every reasoning item's account-bound identity
  // (encrypted_content + provider id) in the blob before it reaches the model.
  // Deliberately NO FK: provenance must OUTLIVE the account's hard-disconnect (a
  // stale-but-null tag still mismatches a live codex id, so the strip stays
  // correct either way). NULL on both sides (non-codex freeze + non-codex
  // resume) is a no-op, so single-account and non-codex sessions are unchanged.
  frozenCodexCredentialId: uuid("frozen_codex_credential_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Conversation truth: ordered, verbatim SDK input items (issue #35). The
// model-facing memory store — unredacted and replay-ready. session_events
// remains the redacted human/audit timeline.
export const sessionHistoryItems = pgTable(
  "session_history_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
    // Numeric (not integer) so the synthetic compaction-summary row can be
    // inserted at a FRACTIONAL position (boundaryPosition - 0.5) that sorts ahead
    // of the kept tail without colliding with — and thus overwriting — the real
    // prefix row at boundaryPosition - 1. Normally-appended rows keep whole-number
    // positions; only the summary uses the half-step. `mode: "number"` maps the
    // postgres.js string back to a JS number so every reader stays numeric.
    position: numeric("position", { mode: "number" }).notNull(),
    item: jsonb("item").$type<Record<string, unknown>>().notNull(),
    // Live-row flag for client-side context compaction. The read path selects
    // only active rows; a compaction supersedes the summarized prefix (sets this
    // false — never deletes, so the full transcript stays as an audit trail) and
    // inserts ONE synthetic active summary row at the boundary. Defaults true so
    // every existing and normally-appended row is live.
    active: boolean("active").notNull().default(true),
    // The Codex account that PRODUCED these items: the per-turn resolved codex
    // credential id (pin > workspace-active), or NULL when produced on the
    // non-codex / Azure path (or before this column existed). Used to strip
    // cross-account `reasoning.encrypted_content` blobs — those are account/org-
    // bound, minted by the ChatGPT/Codex backend, so replaying account A's blob
    // into a turn running on account B 400s. The read path drops the encrypted
    // reasoning of any item whose producer != the turn's current codex account.
    // Deliberately NO FK: provenance must OUTLIVE the account's hard-disconnect
    // (an ON DELETE SET NULL would erase the tag, and a stale-but-null tag still
    // mismatches a live codex id so the strip stays correct either way).
    producerCodexCredentialId: uuid("producer_codex_credential_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    positionIdx: uniqueIndex("session_history_items_position_idx").on(
      table.workspaceId,
      table.sessionId,
      table.position,
    ),
  }),
);

// Turn-lineage ledger for a tool call that the SDK emitted but has not yet
// produced a durably reconciled result. The raw call item is model-facing truth
// (not the redacted session-event projection). The attempt/generation identify
// where the call originated, but the receipt survives an approval resume into a
// newer attempt of the same logical turn. Turn-ending transactions
// consume these rows atomically and append a valid interrupted result so a
// recovered model sees an explicit unknown outcome instead of a silently
// dropped call.
export const sessionPendingToolCalls = pgTable(
  "session_pending_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => sessionTurns.id, { onDelete: "cascade" }),
    executionGeneration: integer("execution_generation").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    callId: text("call_id").notNull(),
    callType: text("call_type").notNull(),
    callItem: jsonb("call_item").$type<Record<string, unknown>>().notNull(),
    resultItem: jsonb("result_item").$type<Record<string, unknown>>(),
    resultRecordedAt: timestamp("result_recorded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAttempt: foreignKey({
      name: "pending_tool_calls_workspace_attempt_fk",
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [sessionTurnAttempts.workspaceId, sessionTurnAttempts.id],
    }).onDelete("restrict"),
    turnCall: uniqueIndex("session_pending_tool_calls_turn_call_idx").on(
      table.workspaceId,
      table.turnId,
      table.callId,
    ),
    sessionTurn: index("session_pending_tool_calls_session_turn_idx").on(
      table.workspaceId,
      table.sessionId,
      table.turnId,
    ),
  }),
);

// Sandbox recovery descriptor, decoupled from the RunState blob: the small
// versioned envelope (provider handle / snapshot ref / manifest) needed to
// reattach, restore, or rebuild the session's sandbox on its next turn.
export const sandboxSessionEnvelopes = pgTable(
  "sandbox_session_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: uniqueIndex("sandbox_session_envelopes_session_idx").on(
      table.workspaceId,
      table.sessionId,
    ),
  }),
);

// The 4 liveness states of the singleton lease. Exported so the query layer and
// the stateless resume-by-id path share one source of truth for the domain.
export const sandboxLeaseLivenessValues = ["cold", "warming", "warm", "draining"] as const;

// One row per GROUP: the SOLE enforcer of the strict-singleton-box invariant.
// uniqueIndex(workspaceId, sandboxGroupId) + SELECT…FOR UPDATE + cold->warming
// CAS + integer lease_epoch fence. Re-keyed to sandboxGroupId from the start
// (addendum B.2) so today's 1:1 world (sandboxGroupId == session id, set in
// 0018) is a behavior-preserving no-op. Mirrors the account/workspace FK chain
// of sandboxSessionEnvelopes; sandboxGroupId is a BARE uuid (NOT an FK — the
// value is a session id or an ancestor's, and an FK would let a founder's
// deletion cascade-kill a box still in use by a spawned session).
export const sandboxLeases = pgTable(
  "sandbox_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sandboxGroupId: uuid("sandbox_group_id").notNull(),

    liveness: text("liveness", { enum: sandboxLeaseLivenessValues }).notNull().default("cold"),
    refcount: integer("refcount").notNull().default(0),
    turnHolders: integer("turn_holders").notNull().default(0),
    viewerHolders: integer("viewer_holders").notNull().default(0),

    instanceId: text("instance_id"),
    backend: text("backend").notNull(),
    os: text("os").notNull().default("linux"),
    // The container IMAGE the group box runs (Modal image ref / docker image). A shared
    // box is SHARED STATE: all its sessions run the SAME filesystem, so they must run the
    // same image. This column stamps the image the live box was created with; a resume
    // whose resolved image DIFFERS is a conflict (B3): a solo holder recreates the box on
    // the new image, N-holders are rejected (SandboxImageConflictError). Nullable — a
    // legacy/cold row reads NULL = "image unknown", which never conflicts.
    image: text("image"),
    // The frozen rig version the live box was created under (M3). Like `image`,
    // this is SHARED STATE: all the box's sessions run the same rig-baked setup,
    // so a resume resolving a DIFFERENT rig_version_id conflicts (solo holder
    // recreates cold on the new rig; N-holders throw SandboxRigConflictError).
    // Nullable — a legacy/cold row or a rig-less session reads NULL = "rig
    // unknown", which never conflicts. No FK (symmetric with sandbox_group_id's
    // bare-uuid rationale: this lease outlives no single rig_versions row's RLS).
    rigVersionId: uuid("rig_version_id"),
    dataPlaneUrl: text("data_plane_url"),
    // The REAL PTY terminal (ttyd pty-ws) rides a SEPARATE provider tunnel (7681)
    // from the desktop noVNC (6080), so its resolved URL is cached independently.
    // Recorded under the epoch fence by recordLeaseTerminalDataPlaneUrl; reset to
    // null on every box re-key (warm-commit / fail / drain), symmetric with
    // data_plane_url.
    terminalDataPlaneUrl: text("terminal_data_plane_url"),

    // integer (NOT bigint): the lease-epoch spike proved a raw int8 read returns a
    // JS STRING from postgres-js, breaking the strict epoch-fence comparison (it
    // was always-true → every turn fenced); int4 returns a JS number, the fix.
    // Epochs never approach 2^31, so the narrower type loses nothing.
    leaseEpoch: integer("lease_epoch").notNull().default(0),

    // The group box-envelope (the "envelope split" Critical): the small recovery
    // descriptor to resume()-by-id the group's box without a per-session join.
    resumeBackendId: text("resume_backend_id"),
    resumeState: jsonb("resume_state").$type<Record<string, unknown>>(),

    // Warm-time billing cursor: last_meter_at = accrual cursor; last_meter_tick =
    // idempotency tick (warm_seconds accrued idempotent on
    // (sandbox_group_id, lease_epoch, last_meter_tick) in P2.1).
    lastMeterAt: timestamp("last_meter_at", { withTimezone: true }),
    lastMeterTick: integer("last_meter_tick").notNull().default(0),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    groupIdx: uniqueIndex("sandbox_leases_group_idx").on(table.workspaceId, table.sandboxGroupId),
    reaperIdx: index("sandbox_leases_reaper_idx")
      .on(table.expiresAt)
      .where(sql`${table.liveness} in ('warming','warm','draining')`),
  }),
);

// N rows per group: one per live holder. Makes release idempotent
// (delete-my-row, never blind decrement) and lets the reaper recompute refcount.
export const sandboxLeaseHolders = pgTable(
  "sandbox_lease_holders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    leaseId: uuid("lease_id")
      .notNull()
      .references(() => sandboxLeases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["turn", "viewer"] }).notNull(),
    holderId: text("holder_id").notNull(),
    // The attributing session within the (possibly shared) group.
    subjectId: uuid("subject_id"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    holderIdx: uniqueIndex("sandbox_lease_holders_holder_idx").on(
      table.leaseId,
      table.kind,
      table.holderId,
    ),
    staleIdx: index("sandbox_lease_holders_stale_idx").on(table.kind, table.lastHeartbeatAt),
    leaseIdx: index("sandbox_lease_holders_lease_idx").on(table.leaseId),
  }),
);

// The recording lifecycle states (P4.3). Exported so the activity + the query
// layer share one source of truth for the §3.1 state machine.
export const sessionRecordingStateValues = [
  "recording",
  "finalizing",
  "available",
  "failed",
] as const;
export const sessionRecordingModeValues = ["manual", "on-turn", "on-verify"] as const;
export const sessionRecordingCodecValues = ["h264-mp4", "vp9-webm"] as const;

// One row per recording — the durable index for the "agent films itself proving
// the fix" loop. ffmpeg x11grab of the SAME :0 humans watch, finalized by
// reading the bytes off the box and PUTting them to @opengeni/storage in the
// process that holds the resumed-by-id handle (never a Temporal payload, F10).
// Mirrors the account/workspace/session FK chain of sandboxSessionEnvelopes;
// turnId is ON DELETE SET NULL (a deleted turn must not kill the artifact row).
export const sessionRecordings = pgTable(
  "session_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),

    state: text("state", { enum: sessionRecordingStateValues }).notNull(),
    mode: text("mode", { enum: sessionRecordingModeValues }).notNull(),
    codec: text("codec", { enum: sessionRecordingCodecValues }).notNull(),

    storageKey: text("storage_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    durationSeconds: numeric("duration_seconds").$type<number>(),

    width: integer("width").notNull(),
    height: integer("height").notNull(),

    reason: text("reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    sessionIdx: index("session_recordings_session_idx").on(
      table.workspaceId,
      table.sessionId,
      table.createdAt,
    ),
  }),
);

// Workbench v2 turn-end workspace capture (dossier §10.2; model: sessionRecordings).
// One row per capture revision — a point-in-time snapshot of a session's changed
// files, probed off the live box at turn end. The manifest (tree index + per-repo
// status/diff + file index) and each after-image blob live in @opengeni/storage;
// this row is the durable index the read routes serve from. `revision` is
// monotonic per session (unique (session_id, revision)); `blob_keys` records the
// content-addressed after-image keys this revision references so the keep-latest-10
// GC can delete only blobs no surviving revision shares (set-difference GC without
// a storage read). `lease_epoch` fences a write: an insert whose lease was
// superseded writes zero rows (see insertWorkspaceCapture).
export const workspaceCaptures = pgTable(
  "workspace_captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),

    revision: bigint("revision", { mode: "number" }).notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    // 'available' on a committed capture. 'failed' reserved for a future two-phase
    // write; the current synchronous capture only ever inserts 'available'.
    state: text("state", { enum: ["available", "failed"] })
      .notNull()
      .default("available"),

    // Single JSON manifest blob (tree index + repos + file refs) — the cold-paint payload.
    manifestKey: text("manifest_key"),
    // The fs tree index blob, kept separate from the manifest so the API can inline
    // or sign it independently of the (usually small) manifest metadata.
    treeIndexKey: text("tree_index_key"),
    // Content-addressed after-image blob keys this revision references (GC input).
    blobKeys: jsonb("blob_keys").$type<string[]>().notNull().default([]),

    sizeBytes: bigint("size_bytes", { mode: "number" }),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionRevision: uniqueIndex("workspace_captures_session_revision_idx").on(
      table.sessionId,
      table.revision,
    ),
    latest: index("workspace_captures_latest_idx").on(
      table.workspaceId,
      table.sessionId,
      table.revision,
    ),
  }),
);

// Channel-A interactive PTY sessions (P4.4 / modules/08-channel-a.md §3.1). The
// ONLY new persistent state Channel A needs — FS/Git reads are stateless point
// queries; an interactive PTY is a live in-box process keyed by the SDK's numeric
// exec-session id (writeStdin({sessionId})). We map our UUID ptyId <-> that id,
// the owning workspace/session, the lease_epoch that fences it to the box it was
// opened on (a box re-key strands the PTY -> reaped with reason owner_gone), and
// a last_input_at heartbeat so the reaper can kill idle/orphaned PTYs. Mirrors
// the account/workspace/session FK chain of sandboxSessionEnvelopes.
export const sandboxPtySessions = pgTable(
  "sandbox_pty_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(), // == ptyId on the wire
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // The SDK numeric exec-session id used by writeStdin({ sessionId }). Null until
    // the open exec yields a still-running process (a fast-exiting shell has none).
    execSessionId: integer("exec_session_id"),
    leaseEpoch: integer("lease_epoch").notNull(), // fenced to the box that opened it
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    shell: text("shell").notNull(),
    cwd: text("cwd").notNull(),
    status: text("status").notNull().default("open"), // 'open' | 'closed'
    // The viewer grant/subject that opened it (free-text — access subjects are not
    // always UUIDs, M5; so a text column, never a uuid NOT NULL).
    openedBy: text("opened_by").notNull(),
    lastInputAt: timestamp("last_input_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    openIdx: index("sandbox_pty_sessions_session_idx")
      .on(table.workspaceId, table.sessionId)
      .where(sql`${table.status} = 'open'`),
  }),
);

// ============================================================================
// Bring-your-own-compute (M2): first-class swappable sandboxes + enrollment +
// metrics (migration 0024 / dossier §10.3 + §10.7 + §23). The session→box
// binding becomes a per-session mutable, epoch-fenced active_sandbox_id pointer
// (declared on sessions above) that the routing proxy resolves PER TOOL CALL.

// The lifecycle/enum domains, exported so the query layer + the migration share
// ONE source of truth for each CHECK.
export const enrollmentExposureValues = ["whole-machine"] as const;
export const enrollmentStatusValues = ["active", "revoked"] as const;
export const enrollmentOsValues = ["linux", "macos", "windows"] as const;
export const sandboxKindValues = ["modal", "selfhosted"] as const;

// One row per registered machine. The agent's ed25519 PUBLIC key IS the machine
// identity (the NATS control-plane subject the agent subscribes to maps to it).
// exposure is the loudly-consented access mode; has_display/allow_screen_control
// are the desktop/computer-use consent bits (default false — opt-in). status is
// the active|revoked lifecycle; last_seen_at the heartbeat liveness cursor the
// Machines dashboard renders online/reconnecting/offline from.
export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The agent's ed25519 public key (the machine identity).
    pubkey: text("pubkey").notNull(),
    exposure: text("exposure", { enum: enrollmentExposureValues })
      .notNull()
      .default("whole-machine"),
    hasDisplay: boolean("has_display").notNull().default(false),
    // Refreshed from every connect Hello (Capabilities.op_stream); false for
    // agents predating the op-stream engine.
    opStream: boolean("op_stream").notNull().default(false),
    // When the machine has a display it CANNOT capture (macOS Screen Recording / TCC
    // not granted), the agent reports has_display=false AND a human, actionable reason
    // here (e.g. "grant Screen Recording in System Settings"). NULL means capture is
    // permitted (has_display=true) or the machine is genuinely headless — the reason
    // distinguishes "display present but capture not granted" from plain "no display"
    // so the Machines dashboard / VM picker can surface the specific hint. Refreshed
    // from every connect Hello alongside has_display.
    desktopUnavailableReason: text("desktop_unavailable_reason"),
    allowScreenControl: boolean("allow_screen_control").notNull().default(false),
    status: text("status", { enum: enrollmentStatusValues }).notNull().default("active"),
    // Credential-family fence. Existing rows/migration-era bearers are generation
    // 1; every successful re-enrollment increments this atomically before a new
    // bearer is signed. Auth and self-revoke require an exact row/claim match.
    credentialGeneration: integer("credential_generation").notNull().default(1),
    os: text("os", { enum: enrollmentOsValues }).notNull().default("linux"),
    arch: text("arch").notNull().default("x86_64"),
    // Heartbeat liveness cursor. Null until the first connect.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // Clean going-offline marker (migration 0049). Set when the machine announces a
    // typed GoingOffline (user-stop / self-update / host-shutdown); the liveness
    // derivation reads an un-cleared marker as OFFLINE immediately, regardless of a
    // still-fresh last_seen. Any newer liveness signal (a reconnect Hello or a
    // fresher heartbeat via touchEnrollmentLastSeen) clears BOTH back to NULL. NULL
    // (the default) ⇒ no goodbye pending — today's last_seen-aging behavior.
    wentOfflineAt: timestamp("went_offline_at", { withTimezone: true }),
    wentOfflineReason: text("went_offline_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One enrollment per (workspace, pubkey): a re-enroll is an idempotent upsert.
    workspacePubkey: uniqueIndex("enrollments_workspace_pubkey_idx").on(
      table.workspaceId,
      table.pubkey,
    ),
    // List a workspace's ACTIVE machines without scanning revoked rows.
    workspaceStatus: index("enrollments_workspace_status_idx").on(table.workspaceId, table.status),
  }),
);

// The OAuth 2.0 device-authorization (RFC 8628) PENDING request (M5, migration
// 0025 / dossier §10.2 enrollment + §18 LOUD consent). An agent's `enroll` starts
// a flow (POST /enrollments/device/start) → one short-TTL, single-use row keyed by
// an opaque `device_code` (the agent polls with) + a short `user_code` (the user
// types at the approve page). The user (workspace-membership / workspace:admin
// gated) approves it (POST /enrollments/device/approve), which records WHO
// (subject + label) consented WHEN (approved_at) to WHAT (whole-machine mandatory +
// screen-control per allow_screen_control) and stamps the resulting enrollment_id /
// sandbox_id. The agent then polls (POST /enrollments/device/poll) and the approved
// row yields the EnrollmentCredentials. State machine: pending → approved | denied;
// a pending row past expires_at is EXPIRED; once the agent has polled an approved
// row its credentials, the row flips to consumed (single-use). NOT a long-lived
// record — a retention sweep prunes terminal rows; the durable identity is the
// `enrollments` row the approve produced.
export const deviceEnrollmentStatusValues = ["pending", "approved", "denied", "consumed"] as const;

export const deviceEnrollmentRequests = pgTable(
  "device_enrollment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque code the agent polls with (unguessable, single-use). Unique.
    deviceCode: text("device_code").notNull(),
    // The short human-typed code (e.g. "WDJB-MJHT"). Unique among LIVE (pending)
    // rows via a partial unique index so a recycled code never collides with a
    // terminal row.
    userCode: text("user_code").notNull(),
    // The workspace this request was started for (resolved from the deployment-edge
    // request context — the agent presents the access key, the flow binds to the
    // single managed workspace OR a workspace hint). account_id rides along for RLS.
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The agent's ed25519 public key (the machine identity the enrollment binds to).
    pubkey: text("pubkey").notNull(),
    os: text("os", { enum: enrollmentOsValues }).notNull().default("linux"),
    arch: text("arch").notNull().default("x86_64"),
    machineName: text("machine_name"),
    // The exposure the agent REQUESTED (whole-machine in v1; loudly consented at
    // approve). Mirrors the enrollment column domain.
    requestedExposure: text("requested_exposure", { enum: enrollmentExposureValues })
      .notNull()
      .default("whole-machine"),
    // The agent CAN offer a display (a real screen / Xvfb is available) — gates
    // whether screen-control consent is even meaningful. has_display on the
    // resulting enrollment is derived from this.
    canOfferDisplay: boolean("can_offer_display").notNull().default(false),
    // The agent REQUESTS screen control (computer-use). The user's allow_screen_control
    // at approve is the AUTHORITATIVE consent; this is only the agent's request.
    requestsScreenControl: boolean("requests_screen_control").notNull().default(false),
    status: text("status", { enum: deviceEnrollmentStatusValues }).notNull().default("pending"),
    // ── LOUD CONSENT capture (who/when/what), stamped at approve ──────────────
    approvedBySubjectId: text("approved_by_subject_id"),
    approvedBySubjectLabel: text("approved_by_subject_label"),
    // The user's screen-control consent decision (whole-machine is mandatory at
    // approve; screen-control is opt-in per this flag).
    allowScreenControl: boolean("allow_screen_control").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // The enrollment + sandbox the approve produced (acceptance #2: an enrollment
    // row AND a sandbox row appear). Null until approved.
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
    sandboxId: uuid("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    // The short-TTL expiry; a pending row past this is EXPIRED on poll.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The device_code is the agent's poll key — globally unique + indexed.
    deviceCode: uniqueIndex("device_enrollment_requests_device_code_idx").on(table.deviceCode),
    // The user_code must be unique among LIVE (pending) rows so the approve lookup
    // is unambiguous; a terminal row's code may be recycled.
    userCodePending: uniqueIndex("device_enrollment_requests_user_code_pending_idx")
      .on(table.userCode)
      .where(sql`${table.status} = 'pending'`),
    workspaceCreated: index("device_enrollment_requests_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    expires: index("device_enrollment_requests_expires_idx").on(table.expiresAt),
  }),
);

// The first-class NAMED sandbox a session's active_sandbox_id points AT. kind
// discriminates the backend the routing proxy resolves to: 'modal' (cloud box,
// NULL enrollment_id) or 'selfhosted' (a user's machine, enrollment_id -> the
// enrollment it lives on). The selfhosted-needs-enrollment invariant is pinned by
// the sandboxes_selfhosted_enrollment_chk CHECK in migration 0024. enrollment_id
// is ON DELETE SET NULL so deleting an enrollment never cascade-kills a sandbox a
// session might still point at (the routing layer surfaces agent_offline instead).
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: sandboxKindValues }).notNull(),
    name: text("name").notNull(),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreated: index("sandboxes_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    enrollment: index("sandboxes_enrollment_idx")
      .on(table.enrollmentId)
      .where(sql`${table.enrollmentId} is not null`),
  }),
);

// Last-sample upsert: ONE row per enrollment, overwritten on every sample (the
// PK on enrollment_id is the ON CONFLICT target). The §10.7 signals; nullable
// where a platform/sample may not provide it (no GPU, headless).
export const machineMetricsLatest = pgTable(
  "machine_metrics_latest",
  {
    enrollmentId: uuid("enrollment_id")
      .primaryKey()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cpuPercent: numeric("cpu_percent").$type<number>(),
    load1: numeric("load1").$type<number>(),
    load5: numeric("load5").$type<number>(),
    load15: numeric("load15").$type<number>(),
    memUsedBytes: bigint("mem_used_bytes", { mode: "number" }),
    memTotalBytes: bigint("mem_total_bytes", { mode: "number" }),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }),
    gpuUtilPercent: numeric("gpu_util_percent").$type<number>(),
    gpuMemUsedBytes: bigint("gpu_mem_used_bytes", { mode: "number" }),
    gpuMemTotalBytes: bigint("gpu_mem_total_bytes", { mode: "number" }),
    contention: numeric("contention").$type<number>(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: index("machine_metrics_latest_workspace_idx").on(table.workspaceId),
  }),
);

// Append-only downsampled history (~1/min per enrollment, retained N days). Same
// signal columns as _latest. The (enrollment_id, sampled_at) index serves the
// dashboard time-range read AND the (later) retention sweep.
export const machineMetricsSeries = pgTable(
  "machine_metrics_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cpuPercent: numeric("cpu_percent").$type<number>(),
    load1: numeric("load1").$type<number>(),
    load5: numeric("load5").$type<number>(),
    load15: numeric("load15").$type<number>(),
    memUsedBytes: bigint("mem_used_bytes", { mode: "number" }),
    memTotalBytes: bigint("mem_total_bytes", { mode: "number" }),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }),
    gpuUtilPercent: numeric("gpu_util_percent").$type<number>(),
    gpuMemUsedBytes: bigint("gpu_mem_used_bytes", { mode: "number" }),
    gpuMemTotalBytes: bigint("gpu_mem_total_bytes", { mode: "number" }),
    contention: numeric("contention").$type<number>(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enrollmentSampled: index("machine_metrics_series_enrollment_sampled_idx").on(
      table.enrollmentId,
      table.sampledAt,
    ),
    sampled: index("machine_metrics_series_sampled_idx").on(table.sampledAt),
  }),
);

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    schedule: jsonb("schedule").$type<unknown>().notNull(),
    temporalScheduleId: text("temporal_schedule_id").notNull(),
    runMode: text("run_mode").notNull().default("new_session_per_run"),
    overlapPolicy: text("overlap_policy").notNull().default("allow_concurrent"),
    agentConfig: jsonb("agent_config").$type<unknown>().notNull(),
    reusableSessionId: uuid("reusable_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    variableSetId: uuid("variable_set_id").references(() => workspaceVariableSets.id, {
      onDelete: "restrict",
    }),
    // The rig this task's runs ride; the active version is resolved per fire
    // (migration 0047). NULL ⇒ no rig. FK (-> rigs(id) ON DELETE SET NULL) lives
    // in migration 0047 (forward-reference pattern). Consumed in M3.
    rigId: uuid("rig_id"),
    // Set only by validated create/update paths whose grant held
    // variable-sets:use. Copied onto each dispatched session.
    rigDefaultVariableSetsAuthorized: boolean("rig_default_variable_sets_authorized")
      .notNull()
      .default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    temporalScheduleId: uniqueIndex("scheduled_tasks_workspace_temporal_schedule_id_idx").on(
      table.workspaceId,
      table.temporalScheduleId,
    ),
    status: index("scheduled_tasks_workspace_status_idx").on(table.workspaceId, table.status),
    variableSet: index("scheduled_tasks_variable_set_idx").on(
      table.workspaceId,
      table.variableSetId,
    ),
  }),
);

export const scheduledTaskRuns = pgTable(
  "scheduled_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    triggerType: text("trigger_type").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    triggerEventId: uuid("trigger_event_id"),
    // Stable Temporal producer identity. Activity replay/re-dispatch returns
    // the exact run instead of allocating a second schedule source row.
    producerKey: text("producer_key"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreated: index("scheduled_task_runs_workspace_task_created_idx").on(
      table.workspaceId,
      table.taskId,
      table.createdAt,
    ),
    session: index("scheduled_task_runs_workspace_session_idx").on(
      table.workspaceId,
      table.sessionId,
    ),
    producer: uniqueIndex("scheduled_task_runs_producer_key_uq")
      .on(table.workspaceId, table.producerKey)
      .where(sql`${table.producerKey} is not null`),
  }),
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceInstallation: uniqueIndex("github_installations_workspace_installation_idx").on(
      table.workspaceId,
      table.installationId,
    ),
    installation: index("github_installations_installation_idx").on(table.installationId),
    workspace: index("github_installations_workspace_idx").on(table.workspaceId),
  }),
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id"),
    eventType: text("event_type").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    sourceResourceType: text("source_resource_type"),
    sourceResourceId: text("source_resource_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    exportedToBillingAt: timestamp("exported_to_billing_at", { withTimezone: true }),
    billingProviderEventId: text("billing_provider_event_id"),
  },
  (table) => ({
    idempotency: uniqueIndex("usage_events_idempotency_idx").on(table.idempotencyKey),
    workspaceMetric: index("usage_events_workspace_metric_idx").on(
      table.workspaceId,
      table.eventType,
      table.occurredAt,
    ),
    accountMetric: index("usage_events_account_metric_idx").on(
      table.accountId,
      table.eventType,
      table.occurredAt,
    ),
  }),
);

export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("usd"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotency: uniqueIndex("credit_ledger_entries_idempotency_idx").on(table.idempotencyKey),
    accountCreated: index("credit_ledger_entries_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
  }),
);

export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("stripe"),
    providerCustomerId: text("provider_customer_id").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountProvider: uniqueIndex("billing_customers_account_provider_idx").on(
      table.accountId,
      table.provider,
    ),
    providerCustomer: uniqueIndex("billing_customers_provider_customer_idx").on(
      table.provider,
      table.providerCustomerId,
    ),
  }),
);

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  livemode: text("livemode").notNull().default("false"),
  payload: jsonb("payload").$type<unknown>().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => managedAccounts.id, { onDelete: "set null" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    subjectId: text("subject_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountCreated: index("audit_events_account_created_idx").on(table.accountId, table.occurredAt),
    workspaceCreated: index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
  }),
);

export const packInstallations = pgTable(
  "pack_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packId: text("pack_id").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspacePack: uniqueIndex("pack_installations_workspace_pack_idx").on(
      table.workspaceId,
      table.packId,
    ),
    status: index("pack_installations_workspace_status_idx").on(table.workspaceId, table.status),
  }),
);

export const workspacePacks = pgTable(
  "workspace_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packId: text("pack_id").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspacePack: uniqueIndex("workspace_packs_workspace_pack_idx").on(
      table.workspaceId,
      table.packId,
    ),
  }),
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    snapshotDate: timestamp("snapshot_date", { withTimezone: true }).notNull(),
    snapshotRef: text("snapshot_ref"),
    attributionNote: text("attribution_note").notNull(),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    quarantinedCount: integer("quarantined_count").notNull().default(0),
    logoFailureCount: integer("logo_failure_count").notNull().default(0),
    staleCount: integer("stale_count").notNull().default(0),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceSnapshot: index("import_batches_source_snapshot_idx").on(
      table.source,
      table.snapshotDate,
    ),
    createdAt: index("import_batches_created_at_idx").on(table.createdAt),
  }),
);

export const capabilityCatalogItems = pgTable(
  "capability_catalog_items",
  {
    id: text("id").notNull(),
    accountId: uuid("account_id").references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source").notNull().default("manual"),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull().default("custom"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    homepageUrl: text("homepage_url"),
    endpointUrl: text("endpoint_url"),
    installUrl: text("install_url"),
    authModel: text("auth_model"),
    providerDomain: text("provider_domain"),
    surfaceType: text("surface_type"),
    transport: text("transport"),
    mcpUrl: text("mcp_url"),
    authKind: text("auth_kind"),
    credentialFacts: jsonb("credential_facts")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    tier: text("tier"),
    provenance: text("provenance"),
    logoAssetPath: text("logo_asset_path"),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, {
      onDelete: "set null",
    }),
    stale: boolean("stale").notNull().default(false),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCapability: uniqueIndex("capability_catalog_items_workspace_capability_idx").on(
      table.workspaceId,
      table.id,
    ),
    registrySurface: uniqueIndex("capability_catalog_items_registry_surface_idx").on(
      table.source,
      table.providerDomain,
      table.mcpUrl,
    ),
    globalCapability: uniqueIndex("capability_catalog_items_global_capability_idx")
      .on(table.id)
      .where(sql`${table.workspaceId} is null`),
    kind: index("capability_catalog_items_workspace_kind_idx").on(table.workspaceId, table.kind),
    category: index("capability_catalog_items_workspace_category_idx").on(
      table.workspaceId,
      table.category,
    ),
    source: index("capability_catalog_items_workspace_source_idx").on(
      table.workspaceId,
      table.source,
    ),
    providerDomain: index("capability_catalog_items_provider_domain_idx").on(table.providerDomain),
    importBatch: index("capability_catalog_items_import_batch_idx").on(table.importBatchId),
    stale: index("capability_catalog_items_source_stale_idx").on(table.source, table.stale),
  }),
);

export const capabilityInstallations = pgTable(
  "capability_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    capabilityId: text("capability_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCapability: uniqueIndex("capability_installations_workspace_capability_idx").on(
      table.workspaceId,
      table.capabilityId,
    ),
    kind: index("capability_installations_workspace_kind_idx").on(table.workspaceId, table.kind),
    status: index("capability_installations_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export const socialConnections = pgTable(
  "social_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accountHandle: text("account_handle").notNull(),
    accountName: text("account_name"),
    externalAccountId: text("external_account_id"),
    status: text("status").notNull().default("connected"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    credentialRef: text("credential_ref"),
    tokenMetadata: jsonb("token_metadata").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderHandle: uniqueIndex("social_connections_workspace_provider_handle_idx").on(
      table.workspaceId,
      table.provider,
      table.accountHandle,
    ),
    providerStatus: index("social_connections_workspace_provider_status_idx").on(
      table.workspaceId,
      table.provider,
      table.status,
    ),
  }),
);

export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => socialConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalPostId: text("external_post_id"),
    url: text("url"),
    authorHandle: text("author_handle"),
    text: text("text").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectionExternalPost: uniqueIndex("social_posts_workspace_connection_external_post_idx").on(
      table.workspaceId,
      table.connectionId,
      table.externalPostId,
    ),
    connectionPublished: index("social_posts_workspace_connection_published_idx").on(
      table.workspaceId,
      table.connectionId,
      table.publishedAt,
    ),
    providerPublished: index("social_posts_workspace_provider_published_idx").on(
      table.workspaceId,
      table.provider,
      table.publishedAt,
    ),
  }),
);

// Rigs (migration 0047): workspace-scoped, versioned sandbox machine definitions.
// A rig is the named truth; each sandbox is a disposable fork of a rig version.
export const rigs = pgTable(
  "rigs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Attribution string: 'user:<subject>' | 'session:<id>' | 'system'.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceName: uniqueIndex("rigs_workspace_name_idx").on(table.workspaceId, table.name),
    workspaceCreated: index("rigs_workspace_created_idx").on(table.workspaceId, table.createdAt),
  }),
);

// Append-only, content-immutable rig versions. Exactly one active per rig
// (partial unique index). The domain layer never UPDATEs a content column; only
// the `active` flag flips (activateRigVersion).
export const rigVersions = pgTable(
  "rig_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rigId: uuid("rig_id")
      .notNull()
      .references(() => rigs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    image: text("image"),
    setupScript: text("setup_script"),
    // Self-declared health checks: [{ name, command }].
    checks: jsonb("checks").$type<Array<{ name: string; command: string }>>().notNull().default([]),
    // Registered credential-hook names (resolved to hook implementations in M3).
    credentialHooks: jsonb("credential_hooks").$type<string[]>().notNull().default([]),
    // Variable-set ids layered below the session's variable set at run time (M3).
    defaultVariableSetIds: jsonb("default_variable_set_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    changelog: text("changelog"),
    createdBy: text("created_by"),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rigVersion: uniqueIndex("rig_versions_rig_version_idx").on(table.rigId, table.version),
    // At most one active version per rig — the single-active invariant, in the DB.
    rigActive: uniqueIndex("rig_versions_rig_active_idx")
      .on(table.rigId)
      .where(sql`${table.active}`),
    workspaceRig: index("rig_versions_workspace_rig_idx").on(
      table.workspaceId,
      table.rigId,
      table.version,
    ),
  }),
);

// Proposed/verified rig changes (M4 substrate). M2 creates the table + CRUD only;
// verification/manager-promotion land in M4.
export const rigChanges = pgTable(
  "rig_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rigId: uuid("rig_id")
      .notNull()
      .references(() => rigs.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id").references(() => rigVersions.id, {
      onDelete: "set null",
    }),
    // 'setup_append' | 'definition_edit' (CHECK in migration 0047).
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // 'proposed' | 'verifying' | 'merged' | 'rejected' | 'failed' (CHECK in 0047).
    status: text("status").notNull().default("proposed"),
    proposedBy: text("proposed_by"),
    // Workspace-scoped proposal retry key (migration 0066). Null means each
    // proposal is independent.
    idempotencyKey: text("idempotency_key"),
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    resultVersionId: uuid("result_version_id").references(() => rigVersions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceRig: index("rig_changes_workspace_rig_idx").on(
      table.workspaceId,
      table.rigId,
      table.createdAt,
    ),
    idempotency: uniqueIndex("rig_changes_workspace_idempotency_idx")
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    workspaceStatus: index("rig_changes_workspace_status_idx").on(table.workspaceId, table.status),
  }),
);
