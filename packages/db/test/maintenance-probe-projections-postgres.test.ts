import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { createDb } from "../src/database";
import {
  MAINTENANCE_PROBE_SOURCES,
  MAINTENANCE_PROBE_TABLES,
  MAINTENANCE_PRIVATE_TABLES,
  MAINTENANCE_PROBE_OWNER_ROUTINES,
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
} from "../src/runtime-posture";

let shared: RestrictedRuntimeTestDatabase;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("probe-projections");
  if (!acquired) throw new Error("Strict-owner PostgreSQL required");
  shared = acquired;
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);

const id = () => crypto.randomUUID();
const past = "2000-01-01T00:00:00Z";
const future = "2100-01-01T00:00:00Z";
type Row = Record<string, unknown>;
type Fixture = Record<string, Row[]>;
const group = id(),
  account = id(),
  workspace = id(),
  lease = id(),
  browser = id(),
  enrollment = id();
const artifact = id(),
  version = id();
const cases: { name: string; call: string; rows: Fixture; noLongerDue: Fixture }[] = [
  {
    name: "workflow wake revisions",
    call: "session_workflow_wakes_due_v1()",
    rows: {
      session_workflow_wake_outbox: [
        { session_id: id(), wake_revision: 2, delivered_revision: 1, next_attempt_at: past },
      ],
    },
    noLongerDue: {
      session_workflow_wake_outbox: [
        { wake_revision: 2, delivered_revision: 2, next_attempt_at: past },
      ],
    },
  },
  {
    name: "site auth deadline and live claim",
    call: "site_auth_maintenance_due_v1(60000)",
    rows: {
      site_auth_connections: [
        {
          id: id(),
          status: "active",
          health_policy: { mode: "maintained", unrelated: "not projected" },
          next_check_at: past,
        },
      ],
    },
    noLongerDue: {
      site_auth_connections: [{ maintenance_operation_id: id(), maintenance_claimed_at: future }],
    },
  },
  {
    name: "warm lease",
    call: "sandbox_lease_reaper_due_v1()",
    rows: { sandbox_leases: [{ id: lease, liveness: "warm" }] },
    noLongerDue: { sandbox_leases: [{ liveness: "cold" }] },
  },
  {
    name: "holder-only reaper branch",
    call: "sandbox_lease_reaper_due_v1()",
    rows: { sandbox_lease_holders: [{ id: id(), lease_id: lease }] },
    noLongerDue: {},
  },
  {
    name: "idle checkpoint interval",
    call: "sandbox_idle_checkpoint_due_v1(60000)",
    rows: {
      sandbox_leases: [
        {
          id: lease,
          liveness: "warm",
          backend: "modal",
          instance_id: "box",
          turn_holders: 0,
          refcount: 1,
        },
      ],
    },
    noLongerDue: { sandbox_leases: [{ idle_checkpoint_attempted_at: future }] },
  },
  {
    name: "browser deadline joins",
    call: "browser_deadline_checkpoint_due_v1()",
    rows: {
      sandbox_leases: [
        {
          id: lease,
          account_id: account,
          workspace_id: workspace,
          sandbox_group_id: group,
          instance_id: "box",
          backend: "modal",
          liveness: "warm",
          rotation_reason: "provider_deadline",
          rotation_requested_at: past,
          provider_deadline_at: future,
        },
      ],
      browser_sessions: [
        {
          id: browser,
          account_id: account,
          workspace_id: workspace,
          controller_host_sandbox_group_id: group,
          placement_instance_id: "box",
          placement_kind: "sandbox_group",
          controller_generation: 1,
          controller_id: "controller",
          capabilities: { privateCheckpoint: true },
          lifecycle: "active",
        },
      ],
      sandbox_lease_holders: [
        {
          id: id(),
          lease_id: lease,
          account_id: account,
          workspace_id: workspace,
          kind: "interaction",
          holder_id: `browser-session:${browser}`,
        },
      ],
    },
    noLongerDue: { sandbox_lease_holders: [{ kind: "viewer" }] },
  },
  {
    name: "pending system update",
    call: "session_system_update_outbox_due_v1()",
    rows: { session_system_update_outbox: [{ id: id(), status: "pending" }] },
    noLongerDue: { session_system_update_outbox: [{ status: "delivered" }] },
  },
  {
    name: "expired list snapshot",
    call: "session_list_snapshots_expired_v1()",
    rows: { session_list_snapshots: [{ id: id(), expires_at: past }] },
    noLongerDue: { session_list_snapshots: [{ expires_at: future }] },
  },
  {
    name: "command reconciliation",
    call: "connected_command_reconciliation_due_v1()",
    rows: {
      session_background_commands: [
        { id: id(), state: "running", provider: "connected_machine", reconcile_after: past },
      ],
    },
    noLongerDue: { session_background_commands: [{ reconcile_after: future }] },
  },
  {
    name: "command output and runner reachability",
    call: "connected_command_output_release_due_v1()",
    rows: {
      session_background_commands: [
        {
          id: id(),
          state: "exited",
          provider: "connected_machine",
          reconcile_after: past,
          control_workspace_id: workspace,
          enrollment_id: enrollment,
          connection_instance_id: "connection",
        },
      ],
      enrollments: [
        {
          id: enrollment,
          workspace_id: workspace,
          status: "active",
          connection_instance_id: "connection",
          connection_lease_expires_at: future,
        },
      ],
    },
    noLongerDue: { enrollments: [{ connection_lease_expires_at: past }] },
  },
  {
    name: "retained process reconciliation",
    call: "terminal_retained_processes_due_v1()",
    rows: { sandbox_retained_processes: [{ id: id(), state: "active", reconcile_after: past }] },
    noLongerDue: { sandbox_retained_processes: [{ state: "terminal" }] },
  },
  {
    name: "unsettled home mutation",
    call: "sandbox_ended_epoch_blockers_due_v1()",
    rows: {
      sandbox_workspace_mutation_admissions: [
        { id: id(), route_kind: "home", provider_backend: "modal" },
      ],
    },
    noLongerDue: { sandbox_workspace_mutation_admissions: [{ settled_at: past }] },
  },
  {
    name: "ended-epoch setup uncertainty",
    call: "sandbox_ended_epoch_blockers_due_v1()",
    rows: {
      sessions: [
        {
          id: group,
          workspace_id: workspace,
          active_turn_id: lease,
          direct_control_state: "active",
        },
      ],
      session_turns: [
        {
          id: lease,
          workspace_id: workspace,
          session_id: group,
          status: "recovering",
          metadata: { sandboxSetupOutcomeUnknown: { secret: "not retained" } },
        },
      ],
    },
    noLongerDue: { session_turns: [{ metadata: {} }] },
  },
  {
    name: "unreferenced checkpoint artifact",
    call: "sandbox_checkpoint_artifact_gc_due_v1(60000)",
    rows: { sandbox_checkpoint_artifacts: [{ id: id(), state: "candidate", created_at: past }] },
    noLongerDue: { sandbox_checkpoint_artifacts: [{ created_at: future }] },
  },
  {
    name: "stale checkpoint delete claim",
    call: "sandbox_checkpoint_artifact_gc_due_v1(60000)",
    rows: {
      sandbox_checkpoint_artifacts: [{ id: artifact, state: "deleting", delete_claimed_at: past }],
    },
    noLongerDue: { sandbox_checkpoint_artifacts: [{ delete_claimed_at: future }] },
  },
  {
    name: "checkpoint referenced by a lease",
    call: "sandbox_checkpoint_artifact_gc_due_v1(60000)",
    rows: {
      sandbox_checkpoint_artifacts: [{ id: artifact, state: "candidate", created_at: past }],
      sandbox_leases: [{ id: lease, liveness: "cold" }],
    },
    noLongerDue: { sandbox_leases: [{ current_checkpoint_artifact_id: artifact }] },
  },
  {
    name: "checkpoint referenced by a Rig image",
    call: "sandbox_checkpoint_artifact_gc_due_v1(60000)",
    rows: {
      sandbox_checkpoint_artifacts: [{ id: artifact, state: "candidate", created_at: past }],
      rig_versions: [{ id: version, workspace_id: workspace, active: true, provider_images: {} }],
    },
    noLongerDue: {
      rig_versions: [
        {
          provider_images: {
            modal: { artifactId: artifact, status: "ready", extra: "not retained" },
          },
        },
      ],
    },
  },
  {
    name: "checkpoint referenced by a proposed Rig change",
    call: "sandbox_checkpoint_artifact_gc_due_v1(60000)",
    rows: {
      sandbox_checkpoint_artifacts: [{ id: artifact, state: "candidate", created_at: past }],
      rig_versions: [{ id: version, workspace_id: workspace, active: true, provider_images: {} }],
      rig_changes: [
        {
          id: id(),
          workspace_id: workspace,
          base_version_id: version,
          status: "proposed",
          verification: {},
        },
      ],
    },
    noLongerDue: {
      rig_changes: [
        {
          verification: {
            providerImage: { artifactId: artifact, status: "ready" },
            extra: "not retained",
          },
        },
      ],
    },
  },
];

// Feed each real projection trigger a row with its exact source-column shape,
// without constructing unrelated business lifecycles (turn claims, provider
// provisioning, etc.). The existing maintenance suite exercises real source DML.
// Each case rolls back its fixture tables, rows and settings, even on failure.
for (const scenario of cases)
  test(`strict owner: ${scenario.name}`, async () => {
    const rollback = new Error("rollback fixture");
    await shared.admin
      .begin(async (tx) => {
        const due = async () => {
          await tx.unsafe("SET LOCAL ROLE opengeni_app");
          try {
            const [row] = await tx.unsafe(`SELECT opengeni_private.${scenario.call} AS due`);
            return row!.due;
          } finally {
            await tx.unsafe("RESET ROLE");
          }
        };
        expect(await due()).toBe(false);
        for (const [source, rows] of Object.entries(scenario.rows)) {
          const projection = `maintenance_probe_${source}`;
          await tx.unsafe(
            `CREATE TABLE ${source}_probe_fixture (LIKE opengeni_private.${projection})`,
          );
          await tx.unsafe(
            `CREATE TRIGGER sync AFTER INSERT OR UPDATE OR DELETE ON ${source}_probe_fixture FOR EACH ROW EXECUTE FUNCTION opengeni_private.${projection}_sync()`,
          );
          for (const row of rows)
            await tx.unsafe(
              `INSERT INTO ${source}_probe_fixture SELECT * FROM jsonb_populate_record(NULL::${source}_probe_fixture, $1::text::jsonb)`,
              [JSON.stringify(row)],
            );
        }
        expect(await due()).toBe(true);
        // Untrusted settings never choose the scope or control projection visibility.
        await tx`SELECT set_config('opengeni.account_id', ${id()}, true), set_config('opengeni.workspace_id', ${id()}, true), set_config('opengeni.subject_id','forged',true)`;
        expect(await due()).toBe(true);
        for (const [source, rows] of Object.entries(scenario.noLongerDue)) {
          for (const row of rows) {
            const columns = Object.keys(row);
            await tx.unsafe(
              `UPDATE ${source}_probe_fixture SET (${columns.join(",")}) = (SELECT ${columns.join(",")} FROM jsonb_populate_record(NULL::${source}_probe_fixture, $1::text::jsonb))`,
              [JSON.stringify(row)],
            );
          }
        }
        if (Object.keys(scenario.noLongerDue).length) expect(await due()).toBe(false);
        for (const source of Object.keys(scenario.rows))
          await tx.unsafe(`DELETE FROM ${source}_probe_fixture`);
        expect(await due()).toBe(false);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

test("index and helper access stays owner-only; source FORCE RLS remains enabled", async () => {
  const [owner] =
    await shared.admin`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${shared.ownerRole}`;
  expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
  for (const source of MAINTENANCE_PROBE_SOURCES) {
    const [table] =
      await shared.admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ${`${shared.schema}.${source}`}::regclass`;
    expect(table, source).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  }
  for (const table of MAINTENANCE_PRIVATE_TABLES) {
    const [privileges] =
      await shared.admin`SELECT has_table_privilege('opengeni_app', ${`opengeni_private.${table}`}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS direct,
      has_any_column_privilege('opengeni_app', ${`opengeni_private.${table}`}, 'SELECT,INSERT,UPDATE,REFERENCES') AS columns`;
    expect(privileges, table).toEqual({ direct: false, columns: false });
  }
  for (const routine of MAINTENANCE_PROBE_OWNER_ROUTINES) {
    const [privileges] =
      await shared.admin`SELECT has_function_privilege('opengeni_app', ${`opengeni_private.${routine}`}, 'EXECUTE') AS app,
      has_function_privilege('public', ${`opengeni_private.${routine}`}, 'EXECUTE') AS public`;
    expect(privileges, routine).toEqual({ app: false, public: false });
  }
});

test("all registered probes execute in a read-only transaction without an assigned write xid", async () => {
  await shared.admin.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe("SET LOCAL ROLE opengeni_app");
    for (const call of new Set([
      ...cases.map((scenario) => scenario.call),
      "automatic_session_title_fanout_due_v1()",
      "knowledge_index_due_v1('embedding',3)",
    ])) {
      const [row] = await tx.unsafe(`SELECT opengeni_private.${call} AS due`);
      expect(row!.due, call).toBe(false);
    }
    expect(
      await tx`SELECT * FROM opengeni_private.count_active_retained_processes_by_owner_state()`,
    ).toHaveLength(0);
    expect(
      await tx`SELECT * FROM opengeni_private.count_expired_draining_sandbox_leases()`,
    ).toHaveLength(0);
    const [row] = await tx`SELECT pg_current_xact_id_if_assigned() AS xid`;
    expect(row!.xid).toBeNull();
  });
});

test("claim capabilities cannot be forged and successful or failed calls leave no authority", async () => {
  await shared.admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE opengeni_app");
    await tx`SELECT set_config('opengeni.maintenance_claim','wakes',true),
      set_config('opengeni.subject_id','forged',true),
      set_config('application_name','opengeni-lossless-v1-session-variable-sets-v1',true)`;
    const [before] =
      await tx`SELECT opengeni_private.maintenance_claim_active(current_user::text,'wakes') AS active`;
    expect(before!.active).toBe(false);
    await tx`SELECT * FROM opengeni_private.claim_session_workflow_wakes(5)`;
    await tx`SELECT * FROM opengeni_private.claim_session_system_update_outbox_v2(5)`;
    await tx`SELECT * FROM opengeni_private.claim_sandbox_checkpoint_artifacts(${id()}::uuid,5,60000)`;
    await tx.unsafe("RESET ROLE");
    expect(await tx`SELECT * FROM opengeni_private.maintenance_claim_capabilities`).toHaveLength(0);
    const borrowed = id();
    await tx`INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
      (${borrowed},pg_backend_pid(),pg_current_xact_id(),'snapshots')`;
    await tx.unsafe("SET LOCAL ROLE opengeni_app");
    await tx`SELECT opengeni_private.reap_expired_session_list_snapshots(5)`;
    await expect(
      tx.savepoint(async (sp) => {
        await sp`SELECT * FROM opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(-1)`;
      }),
    ).rejects.toThrow();
    await tx.unsafe("RESET ROLE");
    expect(
      Array.from(await tx`SELECT id FROM opengeni_private.maintenance_claim_capabilities`),
    ).toEqual([{ id: borrowed }]);
    await tx`DELETE FROM opengeni_private.maintenance_claim_capabilities WHERE id=${borrowed}`;
  });
  // Also verify the committed transaction did not retain a maintenance token.
  expect(
    await shared.admin`SELECT * FROM opengeni_private.maintenance_claim_capabilities`,
  ).toHaveLength(0);
  await expect(
    shared.admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE opengeni_app");
      await tx`INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
      (${id()},pg_backend_pid(),pg_current_xact_id(),'wakes')`;
    }),
  ).rejects.toMatchObject({ code: "42501" });
});

test("checkpoint validators cannot be attached to caller-owned tables or validate forged sources", async () => {
  for (const name of [
    "validate_sandbox_checkpoint_refs",
    "validate_sandbox_checkpoint_artifact_refs",
  ]) {
    await expect(
      shared.admin.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE opengeni_app");
        await tx.unsafe("CREATE TEMP TABLE forged_checkpoint(id uuid)");
        await tx.unsafe(
          `CREATE TRIGGER forged AFTER INSERT ON forged_checkpoint FOR EACH ROW EXECUTE FUNCTION opengeni_private.${name}()`,
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
    // Even an erroneously granted EXECUTE cannot turn a fake source into read authority.
    await expect(
      shared.admin.begin(async (tx) => {
        await tx.unsafe(`GRANT EXECUTE ON FUNCTION opengeni_private.${name}() TO opengeni_app`);
        await tx.unsafe("SET LOCAL ROLE opengeni_app");
        await tx.unsafe("CREATE TEMP TABLE forged_checkpoint(id uuid)");
        await tx.unsafe(
          `CREATE TRIGGER forged AFTER INSERT ON forged_checkpoint FOR EACH ROW EXECUTE FUNCTION opengeni_private.${name}()`,
        );
        await tx`INSERT INTO forged_checkpoint VALUES (${id()})`;
      }),
    ).rejects.toMatchObject({ code: "42501", message: "invalid checkpoint validator source" });
  }
});

test("forward ACL repair preserves custom policy grantees before reprovisioning", async () => {
  const migration = await readFile(
    new URL("../drizzle/0852_maintenance_predicate_privileges.sql", import.meta.url),
    "utf8",
  );
  const customRole = `maintenance_app_${crypto.randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback ACL upgrade fixture");
  await expect(
    shared.admin.begin(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${customRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await tx.unsafe(
        `GRANT EXECUTE ON FUNCTION session_private_actor_visible(uuid,uuid,uuid,text) TO ${customRole}`,
      );
      // Reconstruct 0849's effective PUBLIC grant and absence of direct app ACLs.
      for (const signature of [
        "maintenance_claim_active(text,text)",
        "maintenance_title_event_visible(text,uuid)",
      ]) {
        await tx.unsafe(`GRANT EXECUTE ON FUNCTION opengeni_private.${signature} TO PUBLIC`);
        await tx.unsafe(
          `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM opengeni_app`,
        );
      }
      await tx.unsafe(
        "CREATE POLICY maintenance_wakes_select ON workspaces FOR SELECT USING(false)",
      );
      await tx.unsafe(
        "CREATE POLICY maintenance_wakes_update ON workspaces FOR UPDATE USING(false)",
      );
      await tx.unsafe(`SET LOCAL ROLE "${shared.ownerRole}"`);
      await tx.unsafe(migration);
      for (const signature of [
        "maintenance_claim_active(text,text)",
        "maintenance_title_event_visible(text,uuid)",
      ]) {
        const [acl] = await tx`SELECT
        has_function_privilege('opengeni_app', ${`opengeni_private.${signature}`}, 'EXECUTE') AS app,
        has_function_privilege(${customRole}, ${`opengeni_private.${signature}`}, 'EXECUTE') AS custom,
        has_function_privilege('public', ${`opengeni_private.${signature}`}, 'EXECUTE') AS public`;
        expect(acl).toEqual({ app: true, custom: true, public: false });
      }
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

test("posture rejects PUBLIC claim predicates and missing application EXECUTE", async () => {
  const client = createDb(shared.appUrl, { searchPath: shared.schema });
  const options = {
    rlsStrategy: "force" as const,
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
  };
  try {
    for (const signature of [
      "maintenance_claim_active(text,text)",
      "maintenance_title_event_visible(text,uuid)",
    ]) {
      try {
        await shared.admin.unsafe(
          `GRANT EXECUTE ON FUNCTION opengeni_private.${signature} TO PUBLIC`,
        );
        const publicDrift = await inspectRuntimeDatabasePosture(client.db, options);
        expect(evaluateRuntimeDatabasePosture(publicDrift, options)).toContain(
          `maintenance claim predicate ${signature.replaceAll(",", ", ")} is missing or unsafe`,
        );
        await shared.admin.unsafe(
          `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM PUBLIC, opengeni_app`,
        );
        const appDrift = await inspectRuntimeDatabasePosture(client.db, options);
        expect(evaluateRuntimeDatabasePosture(appDrift, options)).toContain(
          `maintenance claim predicate ${signature.replaceAll(",", ", ")} is missing or unsafe`,
        );
      } finally {
        await shared.admin.unsafe(
          `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM PUBLIC`,
        );
        await shared.admin.unsafe(
          `GRANT EXECUTE ON FUNCTION opengeni_private.${signature} TO opengeni_app`,
        );
      }
    }
  } finally {
    await client.close();
  }
});

test("posture rejects column-only capability grants", async () => {
  const client = createDb(shared.appUrl, { searchPath: shared.schema });
  const options = {
    rlsStrategy: "force" as const,
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
  };
  try {
    const clean = await inspectRuntimeDatabasePosture(client.db, options);
    expect(evaluateRuntimeDatabasePosture(clean, options)).toEqual([]);
    await shared.admin.unsafe(
      "GRANT INSERT (id,backend_pid,transaction_id,operation) ON opengeni_private.maintenance_claim_capabilities TO opengeni_app",
    );
    const drift = await inspectRuntimeDatabasePosture(client.db, options);
    expect(evaluateRuntimeDatabasePosture(drift, options)).toContain(
      "maintenance probe index maintenance_claim_capabilities is missing or accessible to runtime",
    );
    await shared.admin.unsafe(
      "REVOKE INSERT (id,backend_pid,transaction_id,operation) ON opengeni_private.maintenance_claim_capabilities FROM opengeni_app",
    );
    await shared.admin.unsafe(
      "GRANT REFERENCES (id) ON opengeni_private.maintenance_claim_capabilities TO opengeni_app",
    );
    const references = await inspectRuntimeDatabasePosture(client.db, options);
    expect(evaluateRuntimeDatabasePosture(references, options)).toContain(
      "maintenance probe index maintenance_claim_capabilities is missing or accessible to runtime",
    );
  } finally {
    await shared.admin.unsafe(
      "REVOKE INSERT (id,backend_pid,transaction_id,operation) ON opengeni_private.maintenance_claim_capabilities FROM opengeni_app",
    );
    await shared.admin.unsafe(
      "REVOKE REFERENCES (id) ON opengeni_private.maintenance_claim_capabilities FROM opengeni_app",
    );
    await client.close();
  }
});

test("strict-owner backfill retains preexisting work and restores FORCE RLS", async () => {
  const migration = await readFile(
    new URL("../drizzle/0848_strict_owner_maintenance_probes.sql", import.meta.url),
    "utf8",
  );
  // Later migrations that widen a projection for their probes. Replaying 0848
  // at head rebuilds its projections with 0848's columns, so these run after it
  // to widen them again, as on a database migrated in order.
  const widening = await Promise.all(
    ["0856_compute_commands_settle_by_push.sql"].map(
      async (name) => await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"),
    ),
  );
  const rollback = new Error("rollback backfill");
  await shared.admin
    .begin(async (tx) => {
      for (const table of MAINTENANCE_PROBE_TABLES) {
        await tx.unsafe(`DROP FUNCTION opengeni_private.${table}_sync() CASCADE`);
        await tx.unsafe(`DROP TABLE opengeni_private.${table}`);
      }
      await tx.unsafe(
        "DROP FUNCTION opengeni_private.maintenance_probe_output_runner_eligible_v1(uuid,uuid,text)",
      );
      await tx`INSERT INTO managed_accounts(id,name) VALUES (${account},'Probe backfill')`;
      await tx`INSERT INTO workspaces(id,account_id,name) VALUES (${workspace},${account},'Probe backfill')`;
      await tx`INSERT INTO sandbox_leases(id,account_id,workspace_id,sandbox_group_id,liveness,backend,expires_at)
      VALUES (${lease},${account},${workspace},${group},'warm','modal',now()+interval '10 minutes')`;
      await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.unsafe(`SET LOCAL ROLE "${shared.ownerRole}"`);
      // A probe a later migration widened names columns 0848 does not project
      // until that migration runs again below.
      await tx.unsafe("SET LOCAL check_function_bodies = off");
      await tx.unsafe(migration);
      await tx.unsafe("SET LOCAL check_function_bodies = on");
      for (const later of widening) await tx.unsafe(later);
      await tx.unsafe("SET LOCAL ROLE opengeni_app");
      const [due] = await tx`SELECT opengeni_private.sandbox_lease_reaper_due_v1() AS due`;
      const [commands] =
        await tx`SELECT opengeni_private.connected_command_reconciliation_due_v1() AS due`;
      expect(typeof commands!.due).toBe("boolean");
      expect(due!.due).toBe(true);
      await tx.unsafe("RESET ROLE");
      const [table] =
        await tx`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'sandbox_leases'::regclass`;
      expect(table!.relforcerowsecurity).toBe(true);
      await tx`UPDATE sandbox_leases SET liveness='cold' WHERE id=${lease}`;
      await tx.unsafe("SET LOCAL ROLE opengeni_app");
      const [settled] = await tx`SELECT opengeni_private.sandbox_lease_reaper_due_v1() AS due`;
      expect(settled!.due).toBe(false);
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
});
