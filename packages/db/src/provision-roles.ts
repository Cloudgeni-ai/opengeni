import postgres from "postgres";
import type { RlsStrategy } from "./database";
import {
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_INSERT_UPDATE_TABLES,
  RUNTIME_READ_ONLY_TABLES,
} from "./runtime-posture";
import {
  classifyRoleRelationships,
  roleRelationshipsCatalogQuery,
  type RoleRelationshipCatalogRow,
} from "./role-relationships";

export type ProvisionResult = {
  appRole: string | null;
  artifactOutboxDispatcherRole: string | null;
  artifactMaterializerRole: string | null;
  hostExportRole: string | null;
  temporalRole: string | null;
  temporalDatabases: string[];
  schema: string;
  rlsStrategy: RlsStrategy;
};

export type ProvisionRolesOptions = {
  /**
   * The schema OpenGeni's tables live in. The app-role GRANTs target this
   * schema + `opengeni_private`. Defaults to `public` (standalone).
   */
  targetSchema?: string;
  /**
   * RLS posture (Step I). `"force"` (default) provisions the non-owner
   * `opengeni_app` login role and GRANTs it table DML in the target schema —
   * the role OpenGeni connects as under FORCE-RLS. `"scoped"` SKIPS the app-role
   * provisioning entirely: the embedded host runs OpenGeni's queries over a role
   * IT owns/manages (typically the schema owner), so OpenGeni neither creates
   * nor grants the `opengeni_app` role. Temporal-role provisioning is unaffected
   * by strategy.
   */
  rlsStrategy?: RlsStrategy;
  appRole?: string;
  appPassword?: string;
  /** Global, EXECUTE-only artifact live-hint dispatcher capability. */
  artifactOutboxDispatcherRole?: string;
  artifactOutboxDispatcherPassword?: string;
  /** Global, EXECUTE-only artifact materialization worker capability. */
  artifactMaterializerRole?: string;
  artifactMaterializerPassword?: string;
  /**
   * Optional cross-workspace projection role. It receives schema USAGE and
   * EXECUTE only on the host-export API; it receives no table privileges.
   * Provision it after the first migration run so the schema exists. The
   * provisioner also registers same-owner default privileges for future
   * host-export functions; shipped migrations preserve existing exporter ACLs
   * when a migration-only upgrade adds a function.
   */
  hostExportRole?: string;
  hostExportPassword?: string;
  temporalRole?: string;
  temporalPassword?: string;
  temporalDatabases?: string[];
};

/**
 * SDK entry point (Step I): provision the OpenGeni database roles + grants over
 * a host-supplied admin connection. This is the named, parameterized form of the
 * historical env-driven `provision-roles` script (which still works as a CLI via
 * the `import.meta.main` block at the bottom — it just reads env into these
 * options).
 *
 * STANDALONE (default): `provisionRoles(adminConnection)` with no options →
 * `targetSchema: "public"`, `rlsStrategy: "force"`, reads `opengeni_app` creds
 * from env. Byte-for-byte the historical script behavior.
 *
 * EMBEDDED: `provisionRoles(adminConnection, { targetSchema, rlsStrategy })` lets
 * a host provision the app role over a dedicated schema (force) OR skip the
 * app role entirely and own the connection role itself (scoped).
 */
export async function provisionRoles(
  adminConnection: string,
  options: ProvisionRolesOptions = {},
): Promise<ProvisionResult> {
  const schema = validateIdentifier("targetSchema", options.targetSchema ?? "public");
  const rlsStrategy: RlsStrategy = options.rlsStrategy ?? "force";

  const appRole = validateIdentifier(
    "appRole",
    options.appRole ?? (process.env.OPENGENI_APP_DATABASE_USER?.trim() || "opengeni_app"),
  );
  const appPassword = options.appPassword ?? process.env.OPENGENI_APP_DATABASE_PASSWORD;
  const artifactOutboxDispatcherRole = validateIdentifier(
    "artifactOutboxDispatcherRole",
    options.artifactOutboxDispatcherRole ??
      (process.env.OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER?.trim() ||
        "opengeni_artifact_outbox_dispatcher"),
  );
  const artifactOutboxDispatcherPassword =
    options.artifactOutboxDispatcherPassword ??
    process.env.OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD;
  const artifactMaterializerRole = validateIdentifier(
    "artifactMaterializerRole",
    options.artifactMaterializerRole ??
      (process.env.OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER?.trim() ||
        "opengeni_artifact_materializer"),
  );
  const artifactMaterializerPassword =
    options.artifactMaterializerPassword ??
    process.env.OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD;
  const hostExportRole = validateIdentifier(
    "hostExportRole",
    options.hostExportRole ??
      (process.env.OPENGENI_HOST_EXPORT_DATABASE_USER?.trim() || "opengeni_host_exporter"),
  );
  const hostExportPassword =
    options.hostExportPassword ?? process.env.OPENGENI_HOST_EXPORT_DATABASE_PASSWORD;
  const temporalRole = validateIdentifier(
    "temporalRole",
    options.temporalRole ??
      (process.env.OPENGENI_TEMPORAL_DATABASE_USER?.trim() || "opengeni_temporal"),
  );
  const temporalPassword =
    options.temporalPassword ?? process.env.OPENGENI_TEMPORAL_DATABASE_PASSWORD;
  const temporalDatabases = (
    options.temporalDatabases ??
    commaSeparated(process.env.OPENGENI_TEMPORAL_DATABASES ?? "temporal,temporal_visibility")
  ).map((name) => validateIdentifier("temporalDatabases", name));

  const sql = postgres(adminConnection, { max: 1 });
  try {
    // FORCE strategy provisions the non-owner app role OpenGeni connects as.
    // SCOPED strategy: the host owns the connection role; OpenGeni provisions no
    // app role (skipped here), only the optional Temporal role.
    let provisionedAppRole: string | null = null;
    if (rlsStrategy === "force") {
      if (!appPassword) {
        throw new Error(
          "OPENGENI_APP_DATABASE_PASSWORD (or appPassword) is required for rlsStrategy 'force'",
        );
      }
      // Ownership and privilege-bearing role-graph edges cannot be safely
      // guessed away. Refuse to mutate an existing role until an operator has
      // explicitly transferred objects/removed those memberships; role
      // attributes and direct grants, however, are deterministic and are
      // converged below on every run. PostgreSQL 16+'s exact non-runtime-bearing
      // creator-management edge is classified separately.
      await assertAppRoleSafeToNormalize(sql, appRole);
      await ensureRestrictedAppLoginRole(sql, appRole, appPassword);
      provisionedAppRole = appRole;
    }

    let provisionedArtifactOutboxDispatcherRole: string | null = null;
    if (artifactOutboxDispatcherPassword) {
      await assertAppRoleSafeToNormalize(sql, artifactOutboxDispatcherRole);
      await ensureRestrictedAppLoginRole(
        sql,
        artifactOutboxDispatcherRole,
        artifactOutboxDispatcherPassword,
      );
      await grantArtifactCapabilityRoleIfSchemaExists(
        sql,
        artifactOutboxDispatcherRole,
        schema,
        "outbox",
      );
      provisionedArtifactOutboxDispatcherRole = artifactOutboxDispatcherRole;
    }

    let provisionedArtifactMaterializerRole: string | null = null;
    if (artifactMaterializerPassword) {
      await assertAppRoleSafeToNormalize(sql, artifactMaterializerRole);
      await ensureRestrictedAppLoginRole(
        sql,
        artifactMaterializerRole,
        artifactMaterializerPassword,
      );
      await grantArtifactCapabilityRoleIfSchemaExists(
        sql,
        artifactMaterializerRole,
        schema,
        "materializer",
      );
      provisionedArtifactMaterializerRole = artifactMaterializerRole;
    }

    if (temporalPassword) {
      await ensureLoginRole(sql, temporalRole, temporalPassword);
      for (const database of temporalDatabases) {
        await ensureDatabase(sql, database, temporalRole);
        await grantTemporalRoleInDatabase(adminConnection, database, temporalRole);
      }
    }

    if (hostExportPassword) {
      await ensureLoginRole(sql, hostExportRole, hostExportPassword);
      await grantHostExportRoleIfSchemaExists(sql, hostExportRole);
    }

    if (rlsStrategy === "force") {
      await grantAppRoleIfSchemaExists(sql, appRole, schema);
    }

    return {
      appRole: provisionedAppRole,
      artifactOutboxDispatcherRole: provisionedArtifactOutboxDispatcherRole,
      artifactMaterializerRole: provisionedArtifactMaterializerRole,
      hostExportRole: hostExportPassword ? hostExportRole : null,
      temporalRole: temporalPassword ? temporalRole : null,
      temporalDatabases: temporalPassword ? temporalDatabases : [],
      schema,
      rlsStrategy,
    };
  } finally {
    await sql.end();
  }
}

/**
 * The exporter is intentionally separate from `opengeni_app`: its functions
 * project every workspace into a host-owned sink and therefore cannot be made
 * available to the tenant-scoped application role.
 */
async function grantHostExportRoleIfSchemaExists(sql: postgres.Sql, role: string): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_host_export') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_host_export TO %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_host_export TO %I', ${literal(role)});
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_host_export GRANT EXECUTE ON FUNCTIONS TO %I', ${literal(role)});
  END IF;
END $$;
`);
}

async function grantArtifactCapabilityRoleIfSchemaExists(
  sql: postgres.Sql,
  role: string,
  dataSchema: string,
  capability: "outbox" | "materializer",
): Promise<void> {
  const routines =
    capability === "outbox"
      ? [
          "claim_editable_artifact_live_outbox(text,integer,integer,name)",
          "mark_editable_artifact_live_outbox_published(text,text,integer,name)",
          "renew_editable_artifact_live_outbox(text,text,integer,integer,name)",
          "retry_editable_artifact_live_outbox(text,text,integer,integer,text,name)",
          "dead_letter_editable_artifact_live_outbox(text,text,integer,text,name)",
          "release_editable_artifact_live_outbox(text,text,integer,name)",
        ]
      : [
          "claim_editable_artifact_materializations(text,integer,integer,name)",
          "renew_editable_artifact_materialization(uuid,uuid,text,text,text,integer,integer,name)",
          "succeed_editable_artifact_materialization(uuid,uuid,text,text,text,integer,text,text,text,bigint,text,text,timestamp with time zone,name)",
          "fail_editable_artifact_materialization(uuid,uuid,text,text,text,integer,text,name)",
        ];
  const routineArray = `ARRAY[${routines.map(literal).join(", ")}]`;
  await sql.unsafe(`
DO $$
DECLARE routine_signature text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${literal(dataSchema)})
    AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_private')
  THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${literal(role)});
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${literal(dataSchema)}, ${literal(role)});
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
      ${literal(dataSchema)}, ${literal(role)}
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
      ${literal(dataSchema)}, ${literal(role)}
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA opengeni_private FROM %I',
      ${literal(role)}
    );
    FOREACH routine_signature IN ARRAY ${routineArray} LOOP
      IF to_regprocedure('opengeni_private.' || routine_signature) IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION opengeni_private.%s TO %I',
          routine_signature, ${literal(role)}
        );
      END IF;
    END LOOP;
  END IF;
END $$;
`);
}

async function ensureLoginRole(sql: postgres.Sql, role: string, password: string): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', ${literal(role)}, ${literal(password)});
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', ${literal(role)}, ${literal(password)});
  END IF;
END $$;
`);
}

async function ensureRestrictedAppLoginRole(
  sql: postgres.Sql,
  role: string,
  password: string,
): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD %L',
      ${literal(role)},
      ${literal(password)}
    );
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD %L',
      ${literal(role)},
      ${literal(password)}
    );
  ELSE
    -- PostgreSQL requires elevated attributes merely to name SUPERUSER,
    -- BYPASSRLS, REPLICATION, or CREATEDB in ALTER ROLE, even when setting them
    -- false. The preflight has already proved those protected attributes are
    -- false, so a managed CREATEROLE administrator converges only the
    -- attributes it may change.
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOCREATEROLE NOINHERIT PASSWORD %L',
      ${literal(role)},
      ${literal(password)}
    );
  END IF;
END $$;
`);
}

/**
 * Fail rather than silently revoking role relationships or transferring owned
 * objects. Those operations have effects outside OpenGeni's runtime grant
 * contract and require an explicit, audited operator decision.
 */
async function assertAppRoleSafeToNormalize(sql: postgres.Sql, role: string): Promise<void> {
  const exists = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${role}) as exists
  `;
  if (!exists[0]?.exists) {
    return;
  }

  const [roleAttributes] = await sql<
    {
      administrator_superuser: boolean;
      app_superuser: boolean;
      app_bypass_rls: boolean;
      app_create_database: boolean;
      app_replication: boolean;
    }[]
  >`
    select
      administrator.rolsuper as administrator_superuser,
      app.rolsuper as app_superuser,
      app.rolbypassrls as app_bypass_rls,
      app.rolcreatedb as app_create_database,
      app.rolreplication as app_replication
    from pg_roles app
    join pg_roles administrator on administrator.rolname = current_user
    where app.rolname = ${role}
  `;
  if (roleAttributes && !roleAttributes.administrator_superuser) {
    const protectedAttributes = [
      roleAttributes.app_superuser ? "SUPERUSER" : null,
      roleAttributes.app_bypass_rls ? "BYPASSRLS" : null,
      roleAttributes.app_create_database ? "CREATEDB" : null,
      roleAttributes.app_replication ? "REPLICATION" : null,
    ].filter((attribute): attribute is string => attribute !== null);
    if (protectedAttributes.length > 0) {
      throw new Error(
        `Refusing to normalize app role ${role}: a non-superuser administrator cannot clear protected attributes (${protectedAttributes.join(", ")})`,
      );
    }
  }

  const relationshipRows = await sql.unsafe<RoleRelationshipCatalogRow[]>(
    roleRelationshipsCatalogQuery("$1"),
    [role],
  );
  const { unsafeRelationships } = classifyRoleRelationships(relationshipRows);
  if (unsafeRelationships.length > 0) {
    throw new Error(
      `Refusing to normalize app role ${role}: remove privilege-bearing role relationships first (${unsafeRelationships.join(", ")})`,
    );
  }

  const ownedObjects = await sql<{ object_name: string }[]>`
    select ('database:' || d.datname)::text as object_name
    from pg_database d
    join pg_roles owner on owner.oid = d.datdba
    where owner.rolname = ${role}
    union all
    select ('schema:' || n.nspname)::text as object_name
    from pg_namespace n
    join pg_roles owner on owner.oid = n.nspowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    union all
    select ('relation:' || n.nspname || '.' || c.relname)::text as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles owner on owner.oid = c.relowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    union all
    select (
      'routine:' || n.nspname || '.' || p.proname || '(' ||
      pg_get_function_identity_arguments(p.oid) || ')'
    )::text as object_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles owner on owner.oid = p.proowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by object_name
  `;
  if (ownedObjects.length > 0) {
    throw new Error(
      `Refusing to normalize app role ${role}: transfer owned objects first (${ownedObjects
        .map((row) => row.object_name)
        .join(", ")})`,
    );
  }
}

async function ensureDatabase(sql: postgres.Sql, database: string, owner: string): Promise<void> {
  const existing = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_database where datname = ${database}) as exists
  `;
  if (!existing[0]?.exists) {
    await sql.unsafe(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(owner)}`);
  }
  await sql.unsafe(
    `GRANT ALL PRIVILEGES ON DATABASE ${identifier(database)} TO ${identifier(owner)}`,
  );
}

async function grantTemporalRoleInDatabase(
  adminConnection: string,
  database: string,
  role: string,
): Promise<void> {
  const databaseUrl = databaseUrlFor(adminConnection, database);
  const databaseSql = postgres(databaseUrl, { max: 1 });
  try {
    await databaseSql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(role)}`);
  } finally {
    await databaseSql.end();
  }
}

/**
 * Grant the app role table DML in the OpenGeni data schema + EXECUTE on the
 * `opengeni_private` helper functions. Schema-parameterized (Step I): standalone
 * passes `public`; embedded passes the dedicated schema. The grants are guarded
 * on schema existence so provisioning before migrate is a safe no-op.
 */
async function grantAppRoleIfSchemaExists(
  sql: postgres.Sql,
  role: string,
  schema: string,
): Promise<void> {
  const runtimeFullDmlTables = `ARRAY[${RUNTIME_FULL_DML_TABLES.map(literal).join(", ")}]`;
  const runtimeReadOnlyTables = `ARRAY[${RUNTIME_READ_ONLY_TABLES.map(literal).join(", ")}]`;
  const runtimeReadInsertTables = `ARRAY[${RUNTIME_READ_INSERT_TABLES.map(literal).join(", ")}]`;
  const runtimeReadInsertUpdateTables = `ARRAY[${RUNTIME_READ_INSERT_UPDATE_TABLES.map(literal).join(", ")}]`;
  await sql.unsafe(`
DO $$
DECLARE
  owner_role text := current_user;
  runtime_table text;
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), ${literal(role)});
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${literal(schema)}) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', ${literal(schema)}, ${literal(role)});
    FOREACH runtime_table IN ARRAY ${runtimeFullDmlTables} LOOP
      IF to_regclass(format('%I.%I', ${literal(schema)}, runtime_table)) IS NOT NULL THEN
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
          ${literal(schema)},
          runtime_table,
          ${literal(role)}
        );
      END IF;
    END LOOP;
    FOREACH runtime_table IN ARRAY ${runtimeReadOnlyTables} LOOP
      IF to_regclass(format('%I.%I', ${literal(schema)}, runtime_table)) IS NOT NULL THEN
        EXECUTE format(
          'GRANT SELECT ON TABLE %I.%I TO %I',
          ${literal(schema)},
          runtime_table,
          ${literal(role)}
        );
      END IF;
    END LOOP;
    FOREACH runtime_table IN ARRAY ${runtimeReadInsertTables} LOOP
      IF to_regclass(format('%I.%I', ${literal(schema)}, runtime_table)) IS NOT NULL THEN
        EXECUTE format(
          'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
          ${literal(schema)},
          runtime_table,
          ${literal(role)}
        );
      END IF;
    END LOOP;
    FOREACH runtime_table IN ARRAY ${runtimeReadInsertUpdateTables} LOOP
      IF to_regclass(format('%I.%I', ${literal(schema)}, runtime_table)) IS NOT NULL THEN
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
          ${literal(schema)},
          runtime_table,
          ${literal(role)}
        );
      END IF;
    END LOOP;
    -- Migration 0110 creates this target-schema-local SECURITY DEFINER
    -- capability before opengeni_app may exist. Re-converge its exact EXECUTE
    -- grant here so the supported migrate-then-provision order is equivalent to
    -- provisioning the role before that migration.
    IF to_regprocedure(
      format('%I.lock_nested_agent_depth_configuration()', ${literal(schema)})
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.lock_nested_agent_depth_configuration() TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.preference_registry_apply_lifecycle(text,uuid,integer,uuid,uuid,text,uuid,text,text)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.preference_registry_apply_lifecycle(text, uuid, integer, uuid, uuid, text, uuid, text, text) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format('%I.preference_registry_lock_heads(uuid[])', ${literal(schema)})
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.preference_registry_lock_heads(uuid[]) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.knowledge_memory_apply_operation(jsonb,text,text,text,uuid,uuid,uuid,integer)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.knowledge_memory_apply_operation(jsonb, text, text, text, uuid, uuid, uuid, integer) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.knowledge_memory_revert_operation(uuid,uuid,text,text,text,uuid,uuid,uuid,integer)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.knowledge_memory_revert_operation(uuid, uuid, text, text, text, uuid, uuid, uuid, integer) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.preference_registry_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.preference_registry_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.workspace_instruction_policy_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.workspace_instruction_policy_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.scoped_knowledge_apply_lifecycle(uuid,text,uuid,text,bigint,text,text,text,text,text,text)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_apply_lifecycle(uuid, text, uuid, text, bigint, text, text, text, text, text, text) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.scoped_knowledge_advance_source_acl(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_advance_source_acl(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.scoped_knowledge_complete_sync(uuid,uuid,text,text,timestamptz,jsonb,text,text,text)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_complete_sync(uuid, uuid, text, text, timestamptz, jsonb, text, text, text) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure(
      format(
        '%I.scoped_knowledge_advance_object_version(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text)',
        ${literal(schema)}
      )
    ) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_advance_object_version(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text) TO %I',
        ${literal(schema)},
        ${literal(role)}
      );
    END IF;
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      owner_role,
      ${literal(schema)},
      ${literal(role)}
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
      owner_role,
      ${literal(schema)},
      ${literal(role)}
    );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_private') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format('REVOKE CREATE ON SCHEMA opengeni_private FROM %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA opengeni_private REVOKE EXECUTE ON FUNCTIONS FROM %I',
      owner_role,
      ${literal(role)}
    );
    -- Global cross-workspace artifact workers are separate capabilities. Never
    -- let the generic tenant-scoped app role inherit them from the historical
    -- blanket grant of already-installed helpers.
    IF to_regprocedure('opengeni_private.claim_editable_artifact_live_outbox(text,integer,integer,name)') IS NOT NULL THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.claim_editable_artifact_live_outbox(text, integer, integer, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.mark_editable_artifact_live_outbox_published(text, text, integer, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.renew_editable_artifact_live_outbox(text, text, integer, integer, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.retry_editable_artifact_live_outbox(text, text, integer, integer, text, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.dead_letter_editable_artifact_live_outbox(text, text, integer, text, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.release_editable_artifact_live_outbox(text, text, integer, name) FROM %I',
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure('opengeni_private.claim_editable_artifact_materializations(text,integer,integer,name)') IS NOT NULL THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.claim_editable_artifact_materializations(text, integer, integer, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.renew_editable_artifact_materialization(uuid, uuid, text, text, text, integer, integer, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.succeed_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, text, text, bigint, text, text, timestamptz, name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.fail_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, name) FROM %I',
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure('opengeni_private.consume_editable_artifact_live_ticket(text,name)') IS NOT NULL THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION opengeni_private.resolve_editable_artifact_ticket_data_schema(name) FROM %I',
        ${literal(role)}
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.put_editable_artifact_live_ticket(text, uuid, uuid, text, text, text, text, text, text, text, text, integer, text, boolean, integer, timestamptz, timestamptz, name) TO %I',
        ${literal(role)}
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.consume_editable_artifact_live_ticket(text, name) TO %I',
        ${literal(role)}
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.cleanup_expired_editable_artifact_live_tickets(integer, name) TO %I',
        ${literal(role)}
      );
    END IF;
    IF to_regprocedure('opengeni_private.authorize_editable_artifact_actor(uuid,uuid,text,text,text,text,text,text,integer,text,text,name)') IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.authorize_editable_artifact_actor(uuid, uuid, text, text, text, text, text, text, integer, text, text, name) TO %I',
        ${literal(role)}
      );
    END IF;
  END IF;
END $$;
`);
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} contains an invalid Postgres identifier: ${value}`);
  }
  return value;
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function databaseUrlFor(value: string, database: string): string {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

// CLI form (unchanged behavior): read env into the SDK options and run. This is
// what `bun src/provision-roles.ts` / the `provision-roles` package script
// invokes — standalone byte-for-byte the historical script (public schema,
// force strategy, env-driven creds).
if (import.meta.main) {
  const adminUrl =
    process.env.OPENGENI_MIGRATIONS_DATABASE_URL ??
    process.env.OPENGENI_DATABASE_ADMIN_URL ??
    process.env.OPENGENI_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "OPENGENI_MIGRATIONS_DATABASE_URL, OPENGENI_DATABASE_ADMIN_URL, or OPENGENI_DATABASE_URL is required",
    );
  }
  const result = await provisionRoles(adminUrl, {
    ...(process.env.OPENGENI_DB_SCHEMA?.trim()
      ? { targetSchema: process.env.OPENGENI_DB_SCHEMA.trim() }
      : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}
