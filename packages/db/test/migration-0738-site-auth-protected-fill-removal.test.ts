import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  createDb,
  createInteractionIntervention,
  createSession,
  createSiteAuthConnection,
  dispatchBrowserSessionOperation,
  getAuthRun,
  listSiteAuthConnections,
  prepareBrowserSessionCreate,
  startAuthRun,
  type DbClient,
} from "../src/index";

// Migration 0738 §C removes protected-fill site authentication. Only connections
// whose authorities are all provider-managed survive, with their runs,
// interventions and operation journal rows.
const MIGRATION = "0738_vaults.sql";
/** §C starts at this banner; everything before it is §A (vaults). */
const SECTION_C =
  "-- ===========================================================================\n-- §C (W4): remove protected-fill site authentication\n";
/** The preamble `migrate` runs in the same simple query as a migration body. */
const PREAMBLE = `SELECT
  pg_catalog.set_config('lock_timeout', '5s', true),
  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n`;
const REMOVED_STATE = "awaiting_secret";
const REMOVED_KIND = "protected_fill";

async function workspaceScope(db: DbClient["db"]) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: `site-auth-0738-${suffix}`,
    accountName: "Site auth 0738",
    workspaceExternalSource: "test",
    workspaceExternalId: `site-auth-0738-${suffix}`,
    workspaceName: "Site auth 0738",
    subjectId: `user:site-auth-0738-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: grant.subjectId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(db, {
    ...scope,
    operationId,
    associatedSessionId: scope.sessionId,
    name: "Auth browser",
    initialUrl: "https://example.com/login",
    placement: { kind: "sandbox_group", sandboxGroupId: scope.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  await activateBrowserSession(db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.0",
  });
  return { scope, browser: { browserSessionId: prepared.session.id, controllerGeneration } };
}

function providerConnection(name: string) {
  return {
    operationId: crypto.randomUUID(),
    name,
    accountLabel: "test@example.com",
    origins: ["https://example.com"],
    loginUrl: "https://example.com/login",
    verificationUrlPrefixes: ["https://example.com/app"],
    authorities: [
      {
        id: "login",
        kind: "external_provider" as const,
        label: "Kernel managed sign-in",
        adapterId: "kernel",
        connectionId: "kernel-connection-1",
        credential: null,
      },
    ],
    methods: [
      { id: "login", kind: "external" as const, label: "Sign in", authorityIds: ["login"] },
    ],
    preferredIdentityId: null,
    preferredPlacement: null,
    preferredNetworkRouteId: null,
    healthPolicy: { mode: "on_use" as const, intervalSeconds: null, automaticRepair: false },
  };
}

describe("migration 0738 §C site-auth protected-fill removal", () => {
  test("keeps only provider-managed site auth and drops the removed state and kind", async () => {
    const source = await readFile(join(import.meta.dir, "../drizzle", MIGRATION), "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    const sectionC = source.indexOf(SECTION_C);
    expect(sectionC).toBeGreaterThan(0);

    const owned = await acquireOwnerMigratedTestDatabase("migration-0738-site-auth");
    if (!owned) return;
    const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
    let app: DbClient | undefined;
    try {
      // Build the schema as it was before §C (every migration, then 0738 §A),
      // then apply §C by hand as the non-superuser owner. Production applies
      // the whole file in one transaction.
      await owner.unsafe(
        `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
      );
      await owner`insert into schema_migrations (name) values (${MIGRATION})`;
      await migrate(owned.ownerUrl);
      await owner`delete from schema_migrations where name = ${MIGRATION}`;
      await owner.unsafe(`${PREAMBLE}${source.slice(0, sectionC)}`);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      app = createDb(appUrl.toString(), { max: 4 });
      const admin = owned.admin;

      const { scope, browser } = await workspaceScope(app.db);
      const create = async (name: string) =>
        (await createSiteAuthConnection(app!.db, { ...scope, ...providerConnection(name) }))
          .connection.id;
      const provider = await create("Provider");
      const fields = await create("Saved fields");
      const human = await create("Ask a human");
      const start = async (siteAuthConnectionId: string, targetId: string) =>
        (
          await startAuthRun(app!.db, {
            ...scope,
            ...browser,
            operationId: crypto.randomUUID(),
            siteAuthConnectionId,
            targetId,
            expectedTargetGeneration: "target-generation-1",
            expectedDocumentGeneration: "document-generation-1",
            methodId: "login",
            authorityId: "login",
          })
        ).run.id;
      const providerRun = await start(provider, "target-provider");
      const providerWaitingRun = await start(provider, "target-provider-waiting");
      const fieldsRun = await start(fields, "target-fields");
      const humanRun = await start(human, "target-human");
      const intervene = async (authRunId: string, targetId: string) =>
        (
          await createInteractionIntervention(app!.db, {
            ...scope,
            operationId: crypto.randomUUID(),
            resourceKind: "browser_session",
            resourceId: browser.browserSessionId,
            targetId,
            expectedControllerGeneration: browser.controllerGeneration,
            expectedTargetGeneration: "target-generation-1",
            expectedDocumentGeneration: "document-generation-1",
            kind: "manual_login",
            reason: "Finish signing in in this tab.",
            authRunId,
            expiresInSeconds: 900,
            originatingSessionId: scope.sessionId,
          })
        ).intervention.id;
      const providerIntervention = await intervene(providerRun, "target-provider");
      const humanIntervention = await intervene(humanRun, "target-human");

      // Rewrite two connections into the removed authority kinds and put two
      // runs into the removed waiting state, as an earlier release could.
      await admin`update site_auth_connections set authorities = ${admin.json([
        {
          id: "login",
          kind: "connection_fields",
          label: "Saved login",
          credential: {
            connectionId: crypto.randomUUID(),
            connectionSubjectId: null,
            providerDomain: "example.com",
          },
          fields: [{ id: "password", purpose: "password", credentialKey: "password" }],
        },
      ])} where id = ${fields}`;
      await admin`update site_auth_connections set authorities = ${admin.json([
        { id: "login", kind: "human", label: "Ask the user", fields: [] },
      ])} where id = ${human}`;
      const pendingField = [{ id: "password", label: "Password", purpose: "password" }];
      for (const runId of [providerWaitingRun, humanRun]) {
        await admin`update auth_runs set state = ${REMOVED_STATE},
          pending_fields = ${admin.json(pendingField)} where id = ${runId}`;
      }
      for (const runId of [providerRun, fieldsRun]) {
        await admin`insert into interaction_resource_operations (operation_id, account_id,
            workspace_id, resource_kind, resource_id, kind, request_digest, state, error_code,
            actor_subject_id, settled_at)
          values (${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, 'auth_run',
            ${runId}, ${REMOVED_KIND}, ${"0".repeat(64)}, 'failed', 'driver_failed',
            ${scope.actorSubjectId}, now())`;
      }

      await owner.unsafe(`${PREAMBLE}${source.slice(sectionC)}`);

      const connections = await admin<Array<{ id: string }>>`
        select id from site_auth_connections where workspace_id = ${scope.workspaceId}`;
      expect(connections.map((row) => row.id)).toEqual([provider]);
      const runs = await admin<Array<{ id: string }>>`
        select id from auth_runs where workspace_id = ${scope.workspaceId}`;
      expect(runs.map((row) => row.id)).toEqual([providerRun]);
      const interventions = await admin<Array<{ id: string; authRunId: string | null }>>`
        select id, auth_run_id as "authRunId" from interaction_interventions
        where workspace_id = ${scope.workspaceId}`;
      expect(interventions.map((row) => ({ id: row.id, authRunId: row.authRunId }))).toEqual([
        { id: providerIntervention, authRunId: providerRun },
      ]);
      expect(interventions.map((row) => row.id)).not.toContain(humanIntervention);
      const operations = await admin<
        Array<{ resourceKind: string; resourceId: string; kind: string }>
      >`
        select resource_kind as "resourceKind", resource_id as "resourceId", kind
        from interaction_resource_operations where workspace_id = ${scope.workspaceId}
          and resource_kind in ('site_auth_connection', 'auth_run', 'intervention')
        order by created_at`;
      expect(operations.map((row) => row.kind)).not.toContain(REMOVED_KIND);
      expect(new Set(operations.map((row) => row.resourceId))).toEqual(
        new Set([provider, providerRun, providerIntervention]),
      );

      const [column] = await admin<Array<{ count: number }>>`
        select count(*)::int as count from information_schema.columns
        where table_name = 'auth_runs' and column_name = 'pending_fields'`;
      expect(column!.count).toBe(0);
      const constraints = await admin<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
        where conname in ('auth_runs_state_check', 'auth_runs_projection_check',
          'auth_runs_values_check', 'interaction_resource_operations_kind_check')`;
      expect(constraints).toHaveLength(4);
      for (const constraint of constraints) {
        expect(constraint.definition).not.toContain(REMOVED_STATE);
        expect(constraint.definition).not.toContain(REMOVED_KIND);
      }
      expect(
        constraints.find((row) => row.name === "interaction_resource_operations_kind_check")
          ?.definition,
      ).toContain("external_auth");
      const refused = await admin`update auth_runs set state = ${REMOVED_STATE}
        where id = ${providerRun}`.then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(refused)).toContain("auth_runs_state_check");

      const [forced] = await admin<Array<{ count: number }>>`
        select count(*)::int as count from pg_class
        where relname in ('site_auth_connections', 'auth_runs', 'interaction_interventions',
          'interaction_resource_operations') and relforcerowsecurity`;
      expect(forced!.count).toBe(4);

      // The surviving data still reads through the application layer.
      expect(await getAuthRun(app.db, { ...scope, authRunId: providerRun })).toMatchObject({
        id: providerRun,
        state: "discovering",
      });
      expect((await listSiteAuthConnections(app.db, scope)).connections).toMatchObject([
        { id: provider, authorities: [{ kind: "external_provider" }] },
      ]);
    } finally {
      await app?.close().catch(() => undefined);
      await owner.end().catch(() => undefined);
      await owned.release();
    }
  }, 180_000);
});
