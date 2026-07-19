import { sql } from "drizzle-orm";
import type { Database, RlsStrategy } from "./index";

/**
 * The complete standalone tenant-table contract. Adding or removing a
 * FORCE-RLS table is an architectural change: update this list in the same
 * commit as the migration so startup cannot silently accept an unreviewed gap.
 */
export const FORCE_RLS_TABLES = [
  "agent_run_states",
  "api_keys",
  "audit_events",
  "billing_customers",
  "capability_catalog_items",
  "capability_installations",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "composer_drafts",
  "connections",
  "credit_ledger_entries",
  "device_enrollment_requests",
  "document_bases",
  "document_chunks",
  "documents",
  "enrollments",
  "file_uploads",
  "files",
  "github_installations",
  "import_batches",
  "integration_oauth_state_nonces",
  "knowledge_memories",
  "machine_metrics_latest",
  "machine_metrics_series",
  "pack_installations",
  "rig_changes",
  "rig_versions",
  "rigs",
  "sandbox_lease_holders",
  "sandbox_leases",
  "sandbox_pty_sessions",
  "sandbox_session_envelopes",
  "sandboxes",
  "scheduled_task_runs",
  "scheduled_tasks",
  "session_attempt_interruptions",
  "session_command_receipts",
  "session_events",
  "session_goals",
  "session_history_items",
  "session_list_snapshots",
  "session_mcp_servers",
  "session_pending_tool_calls",
  "session_pins",
  "session_recordings",
  "session_stream_acknowledgments",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turn_attempts",
  "session_turns",
  "session_workflow_wake_outbox",
  "sessions",
  "social_connections",
  "social_posts",
  "usage_events",
  "workspace_captures",
  "workspace_control_events",
  "workspace_inference_controls",
  "workspace_model_policies",
  "workspace_packs",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
] as const;

/**
 * Deployment-global and authentication tables used by ordinary API/worker
 * traffic. They intentionally do not carry workspace RLS: their access model
 * is implemented by the authentication/access layer or by exact global keys.
 */
export const NON_RLS_RUNTIME_TABLES = [
  "auth_identities",
  "auth_rate_limits",
  "auth_sessions",
  "auth_users",
  "auth_verifications",
  "integration_oauth_clients",
  "managed_accounts",
  "stripe_webhook_events",
  "workspace_memberships",
  "workspaces",
] as const;

/**
 * Exact table-DML allowlist for the standalone runtime role. Migration ledger,
 * one-time repair-audit, extension, and operator-only tables stay outside it.
 */
export const RUNTIME_DML_TABLES = [...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES].sort((a, b) =>
  a.localeCompare(b),
);

export type RuntimeDatabasePostureOptions = {
  rlsStrategy: RlsStrategy;
  expectedRole?: string;
  targetSchema?: string;
  protectedTables?: readonly string[];
  runtimeTables?: readonly string[];
};

export type RuntimeDatabaseIdentity = {
  currentUser: string;
  sessionUser: string;
  databaseOwner: string;
  canConnectDatabase: boolean;
  canCreateInDatabase: boolean;
  rowSecurity: string;
  canLogin: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  bypassRls: boolean;
};

export type RuntimeSchemaPosture = {
  name: string;
  owner: string;
  usage: boolean;
  create: boolean;
};

export type RuntimeTablePosture = {
  name: string;
  owner: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  rlsActive: boolean;
  policyCount: number;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  references: boolean;
  trigger: boolean;
};

export type RuntimeRoutinePosture = {
  name: string;
  owner: string;
  execute: boolean;
};

export type RuntimeDatabasePosture = {
  identity: RuntimeDatabaseIdentity;
  memberships: string[];
  schemas: RuntimeSchemaPosture[];
  ownedSchemas: string[];
  ownedRelations: string[];
  tables: RuntimeTablePosture[];
  privateRoutines: RuntimeRoutinePosture[];
};

export class RuntimeDatabasePostureError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Runtime database posture check failed: ${violations.join("; ")}`);
    this.name = "RuntimeDatabasePostureError";
    this.violations = violations;
  }
}

type IdentityRow = {
  current_user: string;
  session_user: string;
  database_owner: string;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  row_security: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) {
    return rows as T[];
  }
  throw new Error("Runtime database posture query returned an unsupported result shape");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return sorted([...left].filter((value) => !right.has(value)));
}

/** Inspect only PostgreSQL catalogs and privilege functions; no tenant rows. */
export async function inspectRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const targetSchema = options.targetSchema?.trim() || "public";

  return await db.transaction(
    async (tx) => {
      const identityRows = resultRows<IdentityRow>(
        await tx.execute(sql`
          select
            current_user::text as current_user,
            session_user::text as session_user,
            pg_get_userbyid(d.datdba)::text as database_owner,
            has_database_privilege(current_user, d.oid, 'CONNECT') as can_connect_database,
            has_database_privilege(current_user, d.oid, 'CREATE') as can_create_in_database,
            current_setting('row_security')::text as row_security,
            r.rolcanlogin,
            r.rolsuper,
            r.rolinherit,
            r.rolcreaterole,
            r.rolcreatedb,
            r.rolreplication,
            r.rolbypassrls
          from pg_roles r
          join pg_database d on d.datname = current_database()
          where r.rolname = current_user
        `),
      );
      const identity = identityRows[0];
      if (!identity) {
        throw new Error("Runtime database posture could not resolve the current PostgreSQL role");
      }

      const mappedIdentity: RuntimeDatabaseIdentity = {
        currentUser: identity.current_user,
        sessionUser: identity.session_user,
        databaseOwner: identity.database_owner,
        canConnectDatabase: identity.can_connect_database,
        canCreateInDatabase: identity.can_create_in_database,
        rowSecurity: identity.row_security,
        canLogin: identity.rolcanlogin,
        superuser: identity.rolsuper,
        inherit: identity.rolinherit,
        createRole: identity.rolcreaterole,
        createDatabase: identity.rolcreatedb,
        replication: identity.rolreplication,
        bypassRls: identity.rolbypassrls,
      };

      // Scoped/embedded topology deliberately leaves ownership and isolation to
      // the host. Prove the connection identity is coherent, but do not impose
      // the standalone opengeni_app object/grant contract on the host's role.
      if (options.rlsStrategy === "scoped") {
        return {
          identity: mappedIdentity,
          memberships: [],
          schemas: [],
          ownedSchemas: [],
          ownedRelations: [],
          tables: [],
          privateRoutines: [],
        };
      }

      const memberships = resultRows<{ relationship: string }>(
        await tx.execute(sql`
          with recursive inherited_roles(oid, rolname) as (
            select parent.oid, parent.rolname
            from pg_auth_members membership
            join pg_roles member on member.oid = membership.member
            join pg_roles parent on parent.oid = membership.roleid
            where member.rolname = current_user
            union
            select parent.oid, parent.rolname
            from inherited_roles inherited
            join pg_auth_members membership on membership.member = inherited.oid
            join pg_roles parent on parent.oid = membership.roleid
          )
          select ('inherits:' || rolname)::text as relationship from inherited_roles
          union
          select ('member:' || member.rolname)::text as relationship
          from pg_auth_members membership
          join pg_roles parent on parent.oid = membership.roleid
          join pg_roles member on member.oid = membership.member
          where parent.rolname = current_user
          order by relationship
        `),
      ).map((row) => row.relationship);

      const schemas = resultRows<{
        name: string;
        owner: string;
        usage: boolean;
        create: boolean;
      }>(
        await tx.execute(sql`
          select
            n.nspname::text as name,
            pg_get_userbyid(n.nspowner)::text as owner,
            has_schema_privilege(current_user, n.oid, 'USAGE') as usage,
            has_schema_privilege(current_user, n.oid, 'CREATE') as create
          from pg_namespace n
          where n.nspname in (${targetSchema}, 'opengeni_private')
          order by n.nspname
        `),
      );

      const ownedSchemas = resultRows<{ name: string }>(
        await tx.execute(sql`
          select n.nspname::text as name
          from pg_namespace n
          join pg_roles r on r.oid = n.nspowner
          where r.rolname = current_user
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname
        `),
      ).map((row) => row.name);

      const ownedRelations = resultRows<{ name: string }>(
        await tx.execute(sql`
          select (n.nspname || '.' || c.relname)::text as name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_roles r on r.oid = c.relowner
          where r.rolname = current_user
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname, c.relname
        `),
      ).map((row) => row.name);

      const tables = resultRows<{
        name: string;
        owner: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        rls_active: boolean;
        policy_count: number;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        can_references: boolean;
        can_trigger: boolean;
      }>(
        await tx.execute(sql`
          select
            c.relname::text as name,
            pg_get_userbyid(c.relowner)::text as owner,
            c.relrowsecurity as rls_enabled,
            c.relforcerowsecurity as rls_forced,
            row_security_active(c.oid) as rls_active,
            (select count(*)::int from pg_policy policy where policy.polrelid = c.oid) as policy_count,
            has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
            has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
            has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate,
            has_table_privilege(current_user, c.oid, 'REFERENCES') as can_references,
            has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${targetSchema}
            and c.relkind in ('r', 'p')
          order by c.relname
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        rlsEnabled: row.rls_enabled,
        rlsForced: row.rls_forced,
        rlsActive: row.rls_active,
        policyCount: row.policy_count,
        select: row.can_select,
        insert: row.can_insert,
        update: row.can_update,
        delete: row.can_delete,
        truncate: row.can_truncate,
        references: row.can_references,
        trigger: row.can_trigger,
      }));

      const privateRoutines = resultRows<{
        name: string;
        owner: string;
        can_execute: boolean;
      }>(
        await tx.execute(sql`
          select
            (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text as name,
            pg_get_userbyid(p.proowner)::text as owner,
            has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'opengeni_private'
            and p.prokind in ('f', 'p')
          order by p.proname, pg_get_function_identity_arguments(p.oid)
        `),
      ).map((row) => ({ name: row.name, owner: row.owner, execute: row.can_execute }));

      return {
        identity: mappedIdentity,
        memberships,
        schemas,
        ownedSchemas,
        ownedRelations,
        tables,
        privateRoutines,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Pure deterministic evaluator used by startup/readiness and unit tests. */
export function evaluateRuntimeDatabasePosture(
  posture: RuntimeDatabasePosture,
  options: RuntimeDatabasePostureOptions,
): string[] {
  const violations: string[] = [];
  const identity = posture.identity;

  if (!identity.currentUser || !identity.sessionUser) {
    violations.push("database identity is empty");
  }
  if (identity.currentUser !== identity.sessionUser) {
    violations.push(
      `current_user ${identity.currentUser} does not match session_user ${identity.sessionUser}`,
    );
  }
  if (!identity.canConnectDatabase) {
    violations.push("runtime role lacks CONNECT on the current database");
  }

  if (options.rlsStrategy === "scoped") {
    return violations;
  }

  const expectedRole = options.expectedRole?.trim() || "opengeni_app";
  const targetSchema = options.targetSchema?.trim() || "public";
  const protectedTables = new Set(options.protectedTables ?? FORCE_RLS_TABLES);
  const runtimeTables = new Set(options.runtimeTables ?? RUNTIME_DML_TABLES);

  if (identity.currentUser !== expectedRole || identity.sessionUser !== expectedRole) {
    violations.push(
      `runtime identity must be ${expectedRole} (current_user=${identity.currentUser}, session_user=${identity.sessionUser})`,
    );
  }
  if (!identity.canLogin) violations.push("runtime role is not LOGIN");
  if (identity.superuser) violations.push("runtime role is SUPERUSER");
  if (identity.bypassRls) violations.push("runtime role has BYPASSRLS");
  if (identity.createRole) violations.push("runtime role has CREATEROLE");
  if (identity.createDatabase) violations.push("runtime role has CREATEDB");
  if (identity.replication) violations.push("runtime role has REPLICATION");
  if (identity.inherit) violations.push("runtime role must be NOINHERIT");
  if (identity.databaseOwner === expectedRole) violations.push("runtime role owns the database");
  if (identity.canCreateInDatabase) {
    violations.push("runtime role has CREATE on the current database");
  }
  if (identity.rowSecurity.toLowerCase() !== "on") {
    violations.push(`row_security is ${identity.rowSecurity}, expected on`);
  }
  if (posture.memberships.length > 0) {
    violations.push(`runtime role has memberships: ${sorted(posture.memberships).join(", ")}`);
  }
  if (posture.ownedSchemas.length > 0) {
    violations.push(`runtime role owns schemas: ${sorted(posture.ownedSchemas).join(", ")}`);
  }
  if (posture.ownedRelations.length > 0) {
    violations.push(`runtime role owns relations: ${sorted(posture.ownedRelations).join(", ")}`);
  }

  for (const schemaName of new Set([targetSchema, "opengeni_private"])) {
    const schema = posture.schemas.find((candidate) => candidate.name === schemaName);
    if (!schema) {
      violations.push(`required schema ${schemaName} is missing`);
      continue;
    }
    if (schema.owner === expectedRole) {
      violations.push(`runtime role owns schema ${schemaName}`);
    }
    if (!schema.usage) violations.push(`runtime role lacks USAGE on schema ${schemaName}`);
    if (schema.create) violations.push(`runtime role has CREATE on schema ${schemaName}`);
  }

  const tableByName = new Map(posture.tables.map((table) => [table.name, table]));
  const actualRlsTables = new Set(
    posture.tables.filter((table) => table.rlsEnabled).map((table) => table.name),
  );
  const protectedWithoutDml = difference(protectedTables, runtimeTables);
  if (protectedWithoutDml.length > 0) {
    violations.push(
      `protected tables are absent from the runtime DML contract: ${protectedWithoutDml.join(", ")}`,
    );
  }
  const missingRuntimeTables = difference(runtimeTables, new Set(tableByName.keys()));
  if (missingRuntimeTables.length > 0) {
    violations.push(`runtime DML tables are missing: ${missingRuntimeTables.join(", ")}`);
  }
  const missingTables = difference(protectedTables, new Set(tableByName.keys()));
  if (missingTables.length > 0) {
    violations.push(`protected tables are missing: ${missingTables.join(", ")}`);
  }
  const undeclaredRlsTables = difference(actualRlsTables, protectedTables);
  if (undeclaredRlsTables.length > 0) {
    violations.push(
      `RLS tables are absent from the declared contract: ${undeclaredRlsTables.join(", ")}`,
    );
  }

  for (const table of posture.tables) {
    const dml = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
    ] as const;
    const nonDml = [
      ["TRUNCATE", table.truncate],
      ["REFERENCES", table.references],
      ["TRIGGER", table.trigger],
    ] as const;
    if (runtimeTables.has(table.name)) {
      if (table.owner === expectedRole) violations.push(`runtime role owns table ${table.name}`);
      const missingDml = dml.filter(([, granted]) => !granted).map(([privilege]) => privilege);
      if (missingDml.length > 0) {
        violations.push(`table ${table.name} lacks runtime DML: ${missingDml.join(", ")}`);
      }
      const excess = nonDml.filter(([, granted]) => granted).map(([privilege]) => privilege);
      if (excess.length > 0) {
        violations.push(`table ${table.name} grants runtime DDL: ${excess.join(", ")}`);
      }
      continue;
    }

    const excess = [...dml, ...nonDml]
      .filter(([, granted]) => granted)
      .map(([privilege]) => privilege);
    if (excess.length > 0) {
      violations.push(
        `table ${table.name} grants undeclared runtime privileges: ${excess.join(", ")}`,
      );
    }
  }

  for (const tableName of protectedTables) {
    const table = tableByName.get(tableName);
    if (!table) continue;
    if (!table.rlsEnabled) violations.push(`table ${tableName} does not ENABLE RLS`);
    if (!table.rlsForced) violations.push(`table ${tableName} does not FORCE RLS`);
    if (!table.rlsActive) violations.push(`table ${tableName} has inactive RLS for runtime role`);
    if (table.policyCount < 1) violations.push(`table ${tableName} has no RLS policy`);
  }

  if (posture.privateRoutines.length === 0) {
    violations.push("opengeni_private has no helper routines");
  }
  for (const routine of posture.privateRoutines) {
    if (routine.owner === expectedRole) {
      violations.push(`runtime role owns private routine ${routine.name}`);
    }
    if (!routine.execute) {
      violations.push(`runtime role lacks EXECUTE on private routine ${routine.name}`);
    }
  }

  return violations;
}

export async function assertRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const posture = await inspectRuntimeDatabasePosture(db, options);
  const violations = evaluateRuntimeDatabasePosture(posture, options);
  if (violations.length > 0) {
    throw new RuntimeDatabasePostureError(violations);
  }
  return posture;
}

export function runtimeDatabaseReadyCheck(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): () => Promise<void> {
  return async () => {
    await assertRuntimeDatabasePosture(db, options);
  };
}
