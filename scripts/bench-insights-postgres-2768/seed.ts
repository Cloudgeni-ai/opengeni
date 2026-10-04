import postgres from "postgres";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@opengeni/db/schema";
import { executeMigrationFile, migrate } from "../../packages/db/src/migrate";
import { BENCH_CLUSTER_NAME } from "./auth";
import {
  createSession,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls,
  registerDbBinding,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  type DbClient,
} from "@opengeni/db";
import {
  FIXTURE_VERSION,
  OWNER_COUNT,
  SESSION_COUNT,
  fixtureId,
  subject,
  computeOracle,
} from "./oracle";

export type Fixture = {
  version: string;
  accountId: string;
  workspaceA: string;
  workspaceB: string;
  actorSubjectId: string;
  templateSessionId: string;
  calls: number;
};

const BASELINE_SHA = "567c18c8c3a9679af440053c53614e0cec4e03a1";
const OLD_SCOPED = "0585_insights_scoped_fact_projection.sql";
const OLD_MODELS = "0586_organization_model_usage.sql";
const NEW_SCOPED = "0588_insights_scoped_fact_projection.sql";
const NEW_MODELS = "0589_organization_model_usage.sql";
const NEW_AMOUNTS = "0590_complete_insights_usage_amounts.sql";
const PAYER_REPAIR = "0592_insights_claude_subscription_payers.sql";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Sole backend owner's approved unreleased-0590 exception. Do not execute the
 * edited old file twice: record its exact payer-only source delta, then apply
 * the additive 0592 repair to the already-installed definition. */
export function attestRetainedMigrationEdit(
  name: string,
  before: string,
  after: string,
  additions: string[],
) {
  const oldExpression =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription') THEN 'subscription'";
  const newExpression =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription',\n            'workspace-claude-subscription', 'organization-claude-subscription') THEN 'subscription'";
  if (
    name !== NEW_AMOUNTS ||
    !additions.includes(PAYER_REPAIR) ||
    before.split(oldExpression).length !== 2 ||
    before.replace(oldExpression, newExpression) !== after
  )
    throw new Error("Migration edit is not the explicitly approved payer-only 0590/0592 repair");
  return {
    name,
    previousSourceHash: hash(before),
    approvedSourceHash: hash(after),
    forwardRepair: PAYER_REPAIR,
    authorization:
      "Sole backend owner approved payer-only unreleased 0590 edit plus additive 0592, October 2, 2026",
    action: "Record source drift; do not replay already-applied 0590",
  };
}

/** Already-cloned fixture: approved additive migrations and one attested
 * unreleased payer-only source edit repaired forwards. Preserve
 * the original baseline, all immutable rows and every write predicate. The
 * migration receipt is appended to the same implicit transaction as its DDL,
 * so a lost command observation cannot leave a replay-unsafe ledger gap. */
export async function upgradeRetainedFixture(
  maintenance: URL,
  source: { database: string; fixture: Fixture; approvedSha: string },
  sourceEnvironmentPath: string,
  approvedSha: string,
  out: string,
) {
  if (
    !["127.0.0.1", "localhost", "::1"].includes(maintenance.hostname) ||
    !/^og_bench_insights_2768_[a-f0-9]{12}$/.test(source.database) ||
    source.fixture.version !== FIXTURE_VERSION ||
    source.fixture.calls < 2_000_000 ||
    !/^[a-f0-9]{40}$/.test(source.approvedSha) ||
    !/^[a-f0-9]{40}$/.test(approvedSha) ||
    source.approvedSha === approvedSha
  )
    throw new Error("Additive upgrade requires the exact approved retained clone manifest");
  const diff = Bun.spawnSync(
    ["git", "diff", "--name-status", source.approvedSha, approvedSha, "--", "packages/db/drizzle"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0) throw new Error("Cannot inspect approved migration difference");
  const changes = diff.stdout.toString().trim().split("\n");
  if (
    !changes.length ||
    changes.some((line) => !/^[AM]\tpackages\/db\/drizzle\/\d{4}_[a-z0-9_]+\.sql$/.test(line))
  )
    throw new Error("Retained upgrade rejects renames/deletions and unreviewed SQL changes");
  const additions = changes.filter((line) => line.startsWith("A\t"));
  const migrationNames = additions.map((line) => line.split("/").at(-1)!);
  const reviewedSourceEdits = [];
  for (const line of changes.filter((entry) => entry.startsWith("M\t"))) {
    const name = line.split("/").at(-1)!;
    const original = Bun.spawnSync(
      ["git", "show", `${source.approvedSha}:packages/db/drizzle/${name}`],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (original.exitCode !== 0) throw new Error("Cannot attest previous migration source");
    reviewedSourceEdits.push(
      attestRetainedMigrationEdit(
        name,
        original.stdout.toString(),
        await Bun.file(`packages/db/drizzle/${name}`).text(),
        migrationNames,
      ),
    );
  }
  const sources = new Map<string, string>();
  const maintenanceNames = [];
  for (const name of migrationNames) {
    const body = await Bun.file(`packages/db/drizzle/${name}`).text();
    if (
      body.startsWith("-- deployment-mode: maintenance") &&
      ["0585_session_attention_cursor.sql", "0586_private_sessions_fleet_activation.sql"].includes(
        name,
      )
    )
      maintenanceNames.push(name);
    else if (!body.startsWith("-- deployment-mode: rolling"))
      throw new Error("Retained performance upgrade rejects unreviewed maintenance SQL");
    sources.set(name, body);
  }
  const url = new URL(maintenance);
  url.pathname = `/${source.database}`;
  const admin = postgres(url.toString(), { max: 1, prepare: false });
  const checkpointPath = `${out}/upgrade.json`;
  let checkpoint: Record<string, any>;
  const save = async (phase: string) => {
    checkpoint.phase = phase;
    checkpoint.updatedAt = new Date().toISOString();
    await Bun.write(checkpointPath, JSON.stringify(checkpoint, null, 2));
  };
  const writePredicates = (connection: postgres.Sql) => connection`
    select c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles,
      pg_get_expr(p.polqual, p.polrelid) as using_expression,
      pg_get_expr(p.polwithcheck, p.polrelid) as check_expression
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.oid in ('public.usage_events'::regclass, 'public.model_call_facts'::regclass)
      and p.polcmd <> 'r' order by c.relname, p.polname`;
  try {
    const [guard] = await admin`select current_setting('cluster_name') as cluster,
      (select rolsuper from pg_roles where rolname = current_user) as administrator,
      (select rolsuper or rolbypassrls from pg_roles where rolname = 'postgres') as owner_bypass,
      pg_get_userbyid((select datdba from pg_database where datname = current_database())) as database_owner`;
    if (
      guard?.cluster !== BENCH_CLUSTER_NAME ||
      !guard.administrator ||
      guard.owner_bypass !== false ||
      guard.database_owner !== "postgres"
    )
      throw new Error(
        "Additive fixture upgrade requires the dedicated restricted-owner physical clone",
      );
    if (await Bun.file(checkpointPath).exists()) {
      checkpoint = await Bun.file(checkpointPath).json();
      if (
        checkpoint.database !== source.database ||
        checkpoint.approvedSha !== approvedSha ||
        checkpoint.previousSha !== source.approvedSha ||
        JSON.stringify(checkpoint.reviewedSourceEdits ?? []) !== JSON.stringify(reviewedSourceEdits)
      )
        throw new Error("Additive upgrade checkpoint belongs to another fixture/head");
    } else {
      const environment = await Bun.file(sourceEnvironmentPath).json();
      if (environment.approvedBackendSha !== source.approvedSha)
        throw new Error("Prior environment does not attest the source fixture head");
      const installed =
        await admin`select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition
        from pg_proc p where p.oid::regprocedure::text = any(${Object.keys(environment.databaseFunctionHashes)}::text[])`;
      if (
        installed.length !== Object.keys(environment.databaseFunctionHashes).length ||
        installed.some(
          (row) => hash(row.definition) !== environment.databaseFunctionHashes[row.signature],
        )
      )
        throw new Error("Prior measured database functions changed; inspect before upgrade");
      const inventory = await fixtureInventory(admin, source.fixture);
      checkpoint = {
        database: source.database,
        previousSha: source.approvedSha,
        approvedSha,
        beforeCounts: inventory.counts,
        beforeDistribution: inventory.distribution,
        beforeWritePredicates: await writePredicates(admin),
        migrationHashes: Object.fromEntries([...sources].map(([name, body]) => [name, hash(body)])),
        reviewedSourceEdits,
        maintenanceNames,
      };
      await save("prepared");
    }
    const ownerUrl = new URL(url);
    ownerUrl.username = "postgres";
    ownerUrl.password = "";
    const owner = postgres(ownerUrl.toString(), { max: 1, prepare: false });
    try {
      const applied = new Set(
        (await owner<{ name: string }[]>`select name from schema_migrations`).map(
          (row) => row.name,
        ),
      );
      const files = (await readdir("packages/db/drizzle")).filter((file) => file.endsWith(".sql"));
      const pending = files.filter((file) => !applied.has(file)).sort();
      if (pending.some((file) => !sources.has(file)))
        throw new Error("Unexpected older pending migration on retained fixture");
      if (maintenanceNames.length) {
        const [active] = await owner`select count(*)::integer as n from pg_stat_activity
          where datname = current_database() and usename = 'opengeni_app'
            and pid <> pg_backend_pid()`;
        if (active?.n !== 0)
          throw new Error("Reviewed maintenance requires stopped fixture app connections");
      }
      await owner`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
      for (const name of pending) {
        const body = sources.get(name)!;
        if (hash(body) !== checkpoint.migrationHashes[name])
          throw new Error("Approved migration bytes changed after checkpoint");
        await executeMigrationFile(
          owner,
          name,
          `${body}\nINSERT INTO schema_migrations(name) VALUES ('${name}');`,
        );
      }
    } finally {
      await owner.end();
    }
    await save("additive_migrations_applied");
    await migrate(ownerUrl.toString(), undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    const after = await fixtureInventory(admin, source.fixture);
    const afterWritePredicates = await writePredicates(admin);
    if (
      JSON.stringify(after.counts) !== JSON.stringify(checkpoint.beforeCounts) ||
      JSON.stringify(after.distribution) !== JSON.stringify(checkpoint.beforeDistribution) ||
      JSON.stringify(afterWritePredicates) !== JSON.stringify(checkpoint.beforeWritePredicates)
    )
      throw new Error(
        "Immutable fixture amounts/distributions or write predicates changed during additive upgrade",
      );
    checkpoint.afterCounts = after.counts;
    checkpoint.afterWritePredicates = afterWritePredicates;
    await save("verified_same_seed_and_writes");
    const state = { ...source, approvedSha, upgradedFromSha: source.approvedSha };
    await Bun.write(`${out}/fixture.json`, JSON.stringify(state, null, 2));
    return state;
  } finally {
    await admin.end();
  }
}

/** Test-only recovery of this retained fixture across the reviewed branch's
 * migration renumber. The original database is never written, dropped or seeded.
 * This is not a production upgrade path: it clones the exact physical seed,
 * aliases one byte-identical migration, and updates the existing scoped reader
 * with the approved source (CREATE OR REPLACE instead of CREATE only). */
export async function reconcileApprovedFixture(
  maintenance: URL,
  source: { database: string; fixture: Fixture },
  approvedSha: string,
  baselinePath: string,
  out: string,
) {
  const validDatabase = /^og_bench_insights_2768_[a-f0-9]{12}$/;
  if (
    !["127.0.0.1", "localhost", "::1"].includes(maintenance.hostname) ||
    !validDatabase.test(source.database) ||
    source.fixture.version !== FIXTURE_VERSION ||
    source.fixture.calls < 2_000_000 ||
    !/^[a-f0-9]{40}$/.test(approvedSha)
  )
    throw new Error("Reconciliation requires the retained millions-row loopback fixture");
  function git(argv: string[]) {
    const result = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("Fixture migration source inspection failed");
    return result.stdout.toString();
  }
  const approvedFiles = [NEW_SCOPED, NEW_MODELS, NEW_AMOUNTS];
  const allowedChanges = [OLD_SCOPED, OLD_MODELS, ...approvedFiles].map(
    (name) => `packages/db/drizzle/${name}`,
  );
  const changed = git([
    "diff",
    "--name-only",
    BASELINE_SHA,
    approvedSha,
    "--",
    "packages/db/drizzle",
  ])
    .trim()
    .split("\n");
  if (changed.some((name) => !allowedChanges.includes(name)))
    throw new Error("Unexpected migration history change; fixture reconciliation must be reviewed");
  const originalScoped = git(["show", `${BASELINE_SHA}:packages/db/drizzle/${OLD_SCOPED}`]);
  const originalModels = git(["show", `${BASELINE_SHA}:packages/db/drizzle/${OLD_MODELS}`]);
  const scopedSource = await Bun.file(`packages/db/drizzle/${NEW_SCOPED}`).text();
  const modelsSource = await Bun.file(`packages/db/drizzle/${NEW_MODELS}`).text();
  if (originalModels !== modelsSource)
    throw new Error("Organization migration rename is not byte-identical");
  const create = "CREATE FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows(";
  const declaration = (text: string) =>
    text.match(
      /CREATE FUNCTION opengeni_private\.visible_workspace_insights_model_fact_rows\([\s\S]*?LANGUAGE plpgsql/,
    )?.[0];
  if (
    scopedSource.split(create).length !== 2 ||
    !declaration(originalScoped) ||
    declaration(originalScoped) !== declaration(scopedSource)
  )
    throw new Error("Scoped reader identity/return type changed; no fixture replacement permitted");
  const effectiveScoped = scopedSource.replace(
    create,
    create.replace("CREATE", "CREATE OR REPLACE"),
  );
  const database = `og_bench_insights_2768_${hash(`${source.database}:${approvedSha}`).slice(0, 12)}`;
  if (database === source.database) throw new Error("Fixture clone must have a distinct name");
  const checkpointPath = `${out}/reconciliation.json`;
  let checkpoint: Record<string, any>;
  if (await Bun.file(checkpointPath).exists()) {
    checkpoint = await Bun.file(checkpointPath).json();
    if (
      checkpoint.sourceDatabase !== source.database ||
      checkpoint.database !== database ||
      checkpoint.approvedSha !== approvedSha
    )
      throw new Error("Reconciliation checkpoint belongs to a different exact fixture/head");
  } else {
    checkpoint = {
      sourceDatabase: source.database,
      database,
      baselineSha: BASELINE_SHA,
      approvedSha,
      phase: "planned",
      sourceHashes: {
        [OLD_SCOPED]: hash(originalScoped),
        [OLD_MODELS]: hash(originalModels),
        [NEW_SCOPED]: hash(scopedSource),
        [NEW_MODELS]: hash(modelsSource),
        [NEW_AMOUNTS]: hash(await Bun.file(`packages/db/drizzle/${NEW_AMOUNTS}`).text()),
      },
      effectiveScopedHash: hash(effectiveScoped),
      fixtureOnlyTransform:
        "One CREATE FUNCTION becomes CREATE OR REPLACE; signature and return declaration are byte-identical. Approved body/grants/protocol otherwise unchanged.",
    };
    await Bun.write(checkpointPath, JSON.stringify(checkpoint, null, 2));
  }
  const save = async (phase: string) => {
    checkpoint.phase = phase;
    checkpoint.updatedAt = new Date().toISOString();
    await Bun.write(checkpointPath, JSON.stringify(checkpoint, null, 2));
  };
  const controlUrl = new URL(maintenance);
  controlUrl.pathname = "/postgres";
  const control = postgres(controlUrl.toString(), { max: 1, prepare: false });
  try {
    const [guard] = await control`select current_setting('cluster_name') as cluster,
      (select rolsuper from pg_roles where rolname = current_user) as administrator,
      (select rolsuper or rolbypassrls from pg_roles where rolname = 'postgres') as owner_bypass`;
    if (
      guard?.cluster !== BENCH_CLUSTER_NAME ||
      !guard.administrator ||
      guard.owner_bypass !== false
    )
      throw new Error("Dedicated cluster administrator and restricted postgres owner required");
    const sourceUrl = new URL(maintenance);
    sourceUrl.pathname = `/${source.database}`;
    const sourceAdmin = postgres(sourceUrl.toString(), { max: 1, prepare: false });
    try {
      const baselineEnvironment = await Bun.file(`${baselinePath}/plans-environment.json`).json();
      const sources = await sourceAdmin`select p.proname, pg_get_functiondef(p.oid) as definition
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private' and p.proname = any(${Object.keys(baselineEnvironment.databaseFunctionHashes)}::text[])`;
      if (
        sources.length !== Object.keys(baselineEnvironment.databaseFunctionHashes).length ||
        sources.some(
          (row) => hash(row.definition) !== baselineEnvironment.databaseFunctionHashes[row.proname],
        )
      )
        throw new Error("Retained baseline function bodies have changed; refusing clone upgrade");
      const inventory = await fixtureInventory(sourceAdmin, source.fixture);
      checkpoint.beforeCounts = inventory.counts;
      checkpoint.beforeDistribution = inventory.distribution;
      checkpoint.beforeLedgerDistribution = inventory.ledgerDistribution;
      await save(checkpoint.phase);
    } finally {
      await sourceAdmin.end();
    }
    const [existing] =
      await control`select pg_get_userbyid(datdba) as owner from pg_database where datname = ${database}`;
    if (!existing) {
      if (checkpoint.phase !== "planned") throw new Error("Previously created clone is missing");
      const [connections] =
        await control`select count(*)::integer as n from pg_stat_activity where datname = ${source.database}`;
      if (connections!.n !== 0)
        throw new Error("Source fixture has active connections; do not terminate them");
      await control.unsafe(
        `CREATE DATABASE "${database}" TEMPLATE "${source.database}" OWNER postgres`,
      );
    } else if (existing.owner !== "postgres")
      throw new Error("Unexpected existing fixture clone owner");
    await save("cloned");
    const ownerUrl = new URL(maintenance);
    ownerUrl.pathname = `/${database}`;
    ownerUrl.username = "postgres";
    ownerUrl.password = "";
    const owner = postgres(ownerUrl.toString(), { max: 1, prepare: false });
    try {
      const ledger = await owner<
        { name: string }[]
      >`select name from schema_migrations order by name`;
      const names = new Set(ledger.map((row) => row.name));
      const files = (await readdir("packages/db/drizzle")).filter((file) => file.endsWith(".sql"));
      if (names.has(OLD_MODELS) && names.has(OLD_SCOPED)) {
        const missing = files.filter((file) => !names.has(file));
        if (JSON.stringify(missing.sort()) !== JSON.stringify([...approvedFiles].sort()))
          throw new Error("Unexpected pending migration inventory on the physical clone");
        // The repository helper runs this multi-statement SQL in one implicit
        // transaction. Include the ledger aliases so a committed replacement
        // cannot be replayed after a lost command receipt.
        const aliases = `\nUPDATE schema_migrations SET name = '${NEW_SCOPED}', applied_at = now() WHERE name = '${OLD_SCOPED}';
UPDATE schema_migrations SET name = '${NEW_MODELS}' WHERE name = '${OLD_MODELS}';`;
        await owner`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
        await executeMigrationFile(owner, NEW_SCOPED, effectiveScoped + aliases);
      } else if (
        !names.has(NEW_MODELS) ||
        !names.has(NEW_SCOPED) ||
        names.has(OLD_MODELS) ||
        names.has(OLD_SCOPED)
      )
        throw new Error("Unrecognized partial migration rename; inspect before recovery");
    } finally {
      await owner.end();
    }
    await save("renamed_and_scoped_reader_updated");
    await migrate(ownerUrl.toString(), undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    await save("migrated");
    const cloneUrl = new URL(maintenance);
    cloneUrl.pathname = `/${database}`;
    const cloneAdmin = postgres(cloneUrl.toString(), { max: 1, prepare: false });
    try {
      const after = await fixtureInventory(cloneAdmin, source.fixture);
      if (
        JSON.stringify(after.counts) !== JSON.stringify(checkpoint.beforeCounts) ||
        JSON.stringify(after.distribution) !== JSON.stringify(checkpoint.beforeDistribution) ||
        JSON.stringify(after.ledgerDistribution) !==
          JSON.stringify(checkpoint.beforeLedgerDistribution)
      )
        throw new Error("Physical fixture counts/charges/distributions changed during upgrade");
      checkpoint.afterCounts = after.counts;
      checkpoint.migrationLedger =
        await cloneAdmin`select name, applied_at from schema_migrations order by name`;
      await save("verified_same_seed");
      const state = { database, fixture: source.fixture, clonedFrom: source.database, approvedSha };
      await Bun.write(`${out}/fixture.json`, JSON.stringify(state, null, 2));
      return state;
    } finally {
      await cloneAdmin.end();
    }
  } finally {
    await control.end();
  }
}

function idSql(kind: string, expression: string) {
  return `overlay(overlay(md5('${FIXTURE_VERSION}:${kind}:' || (${expression})::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid`;
}

export async function seedFixture(
  admin: postgres.Sql,
  client: DbClient,
  calls: number,
): Promise<Fixture> {
  const access = await ensureManagedAccessForUser(client.db, {
    userId: "bench2768-person-0",
    email: "bench2768-person-0@example.test",
    name: "Benchmark Person 0",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id from organization_memberships
    where account_id = ${accountId} and subject_id = ${subject(0)}`;
  const workspaceA = access.workspaceGrants.find(
    (g) => g.workspaceId !== membership!.personal_workspace_id,
  )!.workspaceId!;
  const workspaceB = fixtureId("workspace-b", 0);
  await admin`insert into session_tenancy_activations
    (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'local-benchmark')
    on conflict do nothing`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subject(0),
  });
  if (!privateSettings.enabled)
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subject(0),
      enabled: true,
      expectedVersion: privateSettings.version,
      operationId: crypto.randomUUID(),
    });
  await admin`insert into workspaces (id, account_id, name) values
    (${workspaceB}, ${accountId}, 'Benchmark shared B') on conflict do nothing`;
  await admin.unsafe(
    `insert into workspaces (id, account_id, name)
    select ${idSql("personal", "i")}, $1::uuid, 'Benchmark Personal ' || i
    from generate_series(1, ${OWNER_COUNT - 1}) i on conflict do nothing`,
    [accountId],
  );
  await admin.unsafe(
    `insert into organization_memberships
    (id, account_id, subject_id, role, status, personal_workspace_id)
    select ${idSql("member", "i")}, $1::uuid, 'user:bench2768-person-' || i,
      'member', 'active', ${idSql("personal", "i")}
    from generate_series(1, ${OWNER_COUNT - 1}) i on conflict do nothing`,
    [accountId],
  );
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    select id, account_id from workspaces where account_id = ${accountId} on conflict do nothing`;
  await admin.unsafe(
    `insert into workspace_memberships
    (account_id, workspace_id, subject_id, subject_label, role, permissions)
    select $1::uuid, w, 'user:bench2768-person-' || i, 'Benchmark Person ' || i,
      case when i = 0 then 'owner' else 'member' end, '[]'::jsonb
    from generate_series(0, ${OWNER_COUNT - 1}) i
    cross join unnest(array[$2::uuid, $3::uuid]) w on conflict do nothing`,
    [accountId, workspaceA, workspaceB],
  );
  for (const table of [
    "workspaces",
    "workspace_inference_controls",
    "organization_memberships",
    "workspace_memberships",
  ]) {
    await admin.unsafe(`analyze ${table}`);
  }
  const [existingTemplate] = await admin<{ id: string }[]>`select id from sessions
    where account_id = ${accountId} and initial_message = 'Synthetic benchmark fixture, no customer data'
      and (title is null or title !~ '^(VISIBLE|HIDDEN|RETIRED)_BENCH_')
      and parent_session_id is null order by created_at limit 1`;
  const template =
    existingTemplate ??
    (await withSessionRlsActorContext({ subjectId: subject(0) }, () =>
      createSession(client.db, {
        accountId,
        workspaceId: workspaceA,
        initialMessage: "Synthetic benchmark fixture, no customer data",
        resources: [],
        metadata: {},
        model: "bench-model-0",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: subject(0) },
        createdByContext: {},
      }),
    ));
  const fixture: Fixture = {
    version: FIXTURE_VERSION,
    accountId,
    workspaceA,
    workspaceB,
    actorSubjectId: subject(0),
    templateSessionId: template.id,
    calls,
  };

  // Bulk fixture writes use the administrator and the real lifecycle capability shape.
  // Query measurements NEVER use this connection, SET ROLE, or a bypass role.
  const seedDb = drizzle(admin, { schema });
  registerDbBinding(seedDb, { rlsStrategy: "force" });
  const workspaces = await admin<
    { id: string }[]
  >`select id from workspaces where account_id = ${accountId} order by id`;
  for (const workspace of workspaces)
    await withWorkspaceSessionActivityRls(seedDb, workspace.id, async (tx) => {
      const capability = crypto.randomUUID();
      await tx.execute(sql`insert into session_visibility_write_capabilities
      (capability_id, backend_pid, transaction_id)
      values (${capability}, pg_backend_pid(), pg_current_xact_id())`);
      await tx.execute(
        sql`select set_config('opengeni.session_visibility_write_capability', ${capability}, true)`,
      );
      for (const children of [false, true]) {
        const source = `with specs as (
        select i, i / 4 as g,
          ((i / 4) + case when i % 4 = 2 and (i / 4) % 11 = 0 and (i / 4) % 3 <> 1 and (i / 4) % 17 <> 0 then 1 else 0 end) % ${OWNER_COUNT} as owner_index,
          ${idSql("session", "i")} as id,
          ${idSql("session", "(i / 4) * 4")} as root_id
        from generate_series(0, ${SESSION_COUNT - 1}) i
        where (i % 4 ${children ? "<>" : "="} 0)
      ), mapped as (
        select specs.*, m.id as membership_id, m.subject_id,
          case when g % 17 = 0 then m.personal_workspace_id
            when g % 17 = 1 then $3::uuid else $2::uuid end as workspace_id,
          case when g % 17 = 0 or g % 3 = 1
            then 'user_private' else 'workspace_shared' end as visibility
        from specs join organization_memberships m
          on m.account_id = $1::uuid and m.subject_id = 'user:bench2768-person-' || owner_index
      )
      insert into sessions select seeded_row.* from mapped cross join sessions template
      cross join lateral jsonb_populate_record(null::sessions,
        to_jsonb(template) || jsonb_build_object(
          'id', mapped.id, 'account_id', $1::uuid, 'workspace_id', mapped.workspace_id,
          'parent_session_id', ${children ? "mapped.root_id" : "null::uuid"},
          'sandbox_group_id', mapped.id, 'created_by_subject_id', mapped.subject_id,
          'owner_subject_id', mapped.subject_id, 'owner_organization_membership_id', mapped.membership_id,
          'visibility', mapped.visibility, 'create_requested_visibility', mapped.visibility,
          'title', case when mapped.visibility = 'user_private' or (mapped.i % 4 = 2 and mapped.g % 11 = 0)
            then 'HIDDEN_BENCH_' || mapped.i else 'VISIBLE_BENCH_' || mapped.i end,
          'title_source', 'user', 'status', 'idle', 'scope_subject_id', mapped.subject_id,
          'created_at', '2026-01-01T00:00:00Z',
          'updated_at', '2026-09-14T03:00:00Z', 'activity_revision', 0, 'activity_revision_pending_xid', null
        )) as seeded_row where template.id = $4::uuid and mapped.workspace_id = $5::uuid
          and not exists (select 1 from sessions existing where existing.id = mapped.id)`;
        const params = [accountId, workspaceA, workspaceB, template.id, workspace.id];
        const tokens = source.split(/\$(\d+)/);
        await tx.execute(
          sql.join(
            tokens.map((token, i) => (i % 2 ? sql`${params[Number(token) - 1]}` : sql.raw(token))),
            sql.raw(""),
          ),
        );
      }
      // Separate sandbox groups are normal for these historical child sessions;
      // no shared live sandbox may cross a subsequent visibility transition.
      await tx.execute(sql`update sessions set sandbox_group_id = id
        where workspace_id = ${workspace.id} and parent_session_id is not null
          and sandbox_group_id <> id`);
      // Retired-session sources must exist when immutable usage is written.
      // They are removed after charging, leaving genuine retained soft references.
      const retiredSource = `with retired as (
        select distinct (k * 9973) % ${SESSION_COUNT} as si
        from generate_series(0, ${Math.floor((calls - 1) / 9973)}) k
      ) insert into sessions select seeded_row.* from retired
        join sessions original on original.id = ${idSql("session", "si")}
        cross join lateral jsonb_populate_record(null::sessions,
          to_jsonb(original) || jsonb_build_object(
            'id', ${idSql("missing-session", "si")}, 'parent_session_id', null,
            'sandbox_group_id', ${idSql("missing-session", "si")},
            'title', 'RETIRED_BENCH_' || si, 'activity_revision', 0,
            'activity_revision_pending_xid', null, 'authority_epoch', 1, 'execution_authority_epoch', 1,
            'last_sequence', 0
          )) as seeded_row
        where original.workspace_id = $1::uuid
          and not exists (select 1 from sessions existing where existing.id = ${idSql("missing-session", "si")})`;
      const retiredTokens = retiredSource.split(/\$(\d+)/);
      await tx.execute(
        sql.join(
          retiredTokens.map((token, i) => (i % 2 ? sql`${workspace.id}` : sql.raw(token))),
          sql.raw(""),
        ),
      );
      await tx.execute(
        sql`delete from session_visibility_write_capabilities where capability_id = ${capability}`,
      );
    });
  // Exercise the actual application visibility lifecycle, including MCP/cache
  // cleanup, for hidden children under otherwise shared roots.
  const privateChildren = await admin<
    { id: string; workspace_id: string; owner_subject_id: string }[]
  >`
    select id, workspace_id, owner_subject_id from sessions where account_id = ${accountId}
      and parent_session_id is not null and visibility = 'workspace_shared'
      and title like 'HIDDEN_BENCH_%' order by id`;
  for (const child of privateChildren)
    await withSessionRlsActorContext({ subjectId: child.owner_subject_id }, () =>
      transitionSessionVisibility(client.db, {
        workspaceId: child.workspace_id,
        sessionId: child.id,
        actorSubjectId: child.owner_subject_id,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `bench2768-private-child-${child.id}`,
      }),
    );
  console.log(
    JSON.stringify({
      phase: "seed-sessions",
      sessions: SESSION_COUNT,
      privateChildTransitions: privateChildren.length,
    }),
  );
  // One completed historical turn per session, with many original model calls.
  // Both facts and ledger source IDs refer to these exact same actual turn rows.
  await admin.unsafe(
    `insert into session_turns (
    id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
    status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend,
    initiator_kind, initiator_subject_id, created_at, finished_at
  ) select case when s.title like 'RETIRED_BENCH_%' then ${idSql("retired-turn", "substring(s.title from '[0-9]+$')::integer")}
      else ${idSql("turn", "substring(s.title from '[0-9]+$')::integer")} end,
    s.account_id, s.workspace_id, s.id, gen_random_uuid(), 'bench2768-historical-' || s.id,
    'completed', 'user', 1, 'Synthetic historical turn', 'bench-model-0', 'medium', 'standard', 'none',
    'subject', s.owner_subject_id, '2026-01-01T00:00:00Z', '2026-09-14T04:00:00Z'
    from sessions s where s.account_id = $1::uuid and s.title ~ '^(VISIBLE|HIDDEN|RETIRED)_BENCH_[0-9]+$'
    on conflict do nothing`,
    [accountId],
  );
  // Fresh-table statistics keep the validation triggers' source lookups indexed.
  for (const table of ["sessions", "session_turns"]) await admin.unsafe(`analyze ${table}`);
  // Independent original-call schedule. No INSERT ... SELECT FROM model_call_facts
  // is used for either usage charges or debit entries.
  const common = `with c as (
    select i, i % ${SESSION_COUNT} as si, (i % ${SESSION_COUNT}) / 4 as g,
      (((i % ${SESSION_COUNT}) / 4) + case when (i % ${SESSION_COUNT}) % 4 = 2 and ((i % ${SESSION_COUNT}) / 4) % 11 = 0
        and ((i % ${SESSION_COUNT}) / 4) % 3 <> 1 and ((i % ${SESSION_COUNT}) / 4) % 17 <> 0 then 1 else 0 end) % ${OWNER_COUNT} as owner_index,
      (i / 72) % 3 as payer, i % 72 as mi,
      100 + i % 901 as input_tokens, 10 + i % 101 as output_tokens,
      timestamp with time zone '2026-01-01T00:00:00Z' + (i % 257) * interval '1 day'
        + (i % 3600) * interval '1 second' as occurred_at
    from generate_series($4::integer, $5::integer) i
  ), original_calls as (
    select c.*, case when g % 17 = 0 then m.personal_workspace_id
      when g % 17 = 1 then $3::uuid else $2::uuid end as workspace_id,
      case when i % 9973 = 0 then ${idSql("missing-session", "si")}
        else ${idSql("session", "si")} end as session_id,
      case when i % 9973 = 0 then ${idSql("retired-turn", "si")}
        else ${idSql("turn", "si")} end as turn_id
    from c join organization_memberships m
      on m.account_id = $1::uuid and m.subject_id = 'user:bench2768-person-' || owner_index
  )`;
  for (let start = 0; start < calls; start += 100_000) {
    const params = [accountId, workspaceA, workspaceB, start, Math.min(start + 99_999, calls - 1)];
    const [existing] =
      await admin`select count(*)::integer as n from model_call_facts where account_id = ${accountId}
      and source_key in (select 'bench2768-call-' || i from generate_series(${start}::integer, ${params[4]!}::integer) i)`;
    if (existing!.n === Math.min(100_000, calls - start)) continue;
    if (existing!.n !== 0)
      throw new Error("Partially populated call batch: inspect it before recovery");
    await admin.begin(async (batch) => {
      await batch.unsafe(
        `${common} insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api, model,
      billing_path, input_tokens, output_tokens, cached_tokens, total_tokens,
      priced_cost_micros, estimated_provider_cost_micros, pricing_source, occurred_at, recorded_at,
      initiator_kind, initiator_subject_id
    ) select $1::uuid, workspace_id, session_id, turn_id, 'bench2768-call-' || i,
      case when payer = 1 then case when mi % 2 = 0 then 'codex-subscription' else 'supergrok-subscription' end
        else case when mi % 2 = 0 then 'openai' else 'anthropic' end end,
      'responses', 'bench-model-' || mi, case when payer = 0 then 'opengeni_credits' else 'external' end,
      input_tokens, output_tokens, input_tokens / 3, input_tokens + output_tokens,
      case when payer = 0 then 101 + i % 97 else 0 end,
      case when i % 7 = 0 then null else 41 + i % 89 end,
      case when i % 7 = 0 then null else 'configured_list_price' end,
      occurred_at, occurred_at, 'subject', 'user:bench2768-person-' || owner_index from original_calls`,
        params,
      );
      await batch.unsafe(
        `${common} insert into usage_events (
      account_id, workspace_id, session_id, turn_id, subject_id, event_type, quantity, unit,
      idempotency_key, occurred_at, recorded_at
    ) select $1::uuid, workspace_id, session_id, turn_id, 'user:bench2768-person-' || owner_index,
      'model.cost', case when payer = 0 then 101 + i % 97 else 0 end, 'usd_micros',
      'bench2768-charge-' || i, occurred_at, occurred_at from original_calls where i % 10007 <> 0`,
        params,
      );
      await batch.unsafe(
        `${common} insert into usage_events (
      account_id, workspace_id, session_id, turn_id, event_type, quantity, unit,
      idempotency_key, occurred_at, recorded_at
    ) select $1::uuid, workspace_id, session_id, turn_id, 'model.tokens', input_tokens + output_tokens,
      'tokens', 'bench2768-tokens-' || i, occurred_at, occurred_at from original_calls`,
        params,
      );
      await batch.unsafe(
        `${common} insert into credit_ledger_entries (
      account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key, occurred_at
    ) select $1::uuid, workspace_id, 'usage_debit', -sum(101 + i % 97), 'benchmark_charge_settlement',
      'bench2768-calls-' || $4::text || '-' || $5::text,
      'bench2768-batch-debit-' || $4::text || '-' || workspace_id::text,
      '2026-09-14T12:00:00Z'::timestamptz from original_calls
      where payer = 0 and i % 10007 <> 0 group by workspace_id`,
        params,
      );
    });
    console.log(JSON.stringify({ phase: "seed", callsInserted: Math.min(start + 100_000, calls) }));
  }
  await admin.unsafe(
    `insert into usage_events
    (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at, recorded_at)
    select $1::uuid, $2::uuid, 'model.cost', 17, 'usd_micros', 'bench2768-ledger-only-' || i,
      '2026-09-14T03:00:00Z', '2026-09-14T03:00:00Z' from generate_series(0, 204) i on conflict do nothing`,
    [accountId, workspaceA],
  );
  for (const workspace of workspaces)
    await withWorkspaceSessionActivityRls(seedDb, workspace.id, async (tx) => {
      await tx.execute(sql`delete from sessions where workspace_id = ${workspace.id}
      and title like 'RETIRED_BENCH_%'`);
    });
  await admin.unsafe(
    `insert into credit_ledger_entries
    (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key, occurred_at)
    select $1::uuid, $2::uuid, 'usage_debit', -17, 'usage_event', 'bench2768-ledger-only-' || i,
      'bench2768-ledger-only-debit-' || i, '2026-09-14T03:00:00Z' from generate_series(0, 204) i on conflict do nothing`,
    [accountId, workspaceA],
  );
  for (const table of [
    "sessions",
    "model_call_facts",
    "usage_events",
    "credit_ledger_entries",
    "organization_memberships",
    "workspace_memberships",
  ]) {
    await admin.unsafe(`analyze ${table}`);
  }
  return fixture;
}

export async function fixtureInventory(admin: postgres.Sql, fixture: Fixture) {
  const [counts] = await admin`
    select (select count(*) from sessions where account_id = ${fixture.accountId})::text as sessions,
      (select count(*) from usage_events where account_id = ${fixture.accountId})::text as "ledgerRows",
      (select count(*) from model_call_facts where account_id = ${fixture.accountId})::text as "factRows",
      (select count(distinct model) from model_call_facts where account_id = ${fixture.accountId})::text as models,
      (select count(distinct owner_subject_id) from sessions where account_id = ${fixture.accountId} and visibility = 'user_private')::text as "privateOwners",
      (select count(*) from organization_memberships where account_id = ${fixture.accountId})::text as members,
      (select count(*) from workspaces where account_id = ${fixture.accountId})::text as workspaces,
      (select coalesce(sum(quantity), 0) from usage_events where account_id = ${fixture.accountId} and event_type = 'model.cost')::text as "chargedMicros",
      (select -coalesce(sum(amount_micros), 0) from credit_ledger_entries where account_id = ${fixture.accountId} and type = 'usage_debit')::text as "debitMicros",
      (select coalesce(sum(priced_cost_micros), 0) from model_call_facts where account_id = ${fixture.accountId})::text as "factCreditMicros",
      (select coalesce(sum(total_tokens), 0) from model_call_facts where account_id = ${fixture.accountId})::text as "factTokens"`;
  const distribution = await admin`
    select provider, billing_path, count(*)::text as calls,
      count(estimated_provider_cost_micros)::text as priced_calls,
      count(*) filter (where estimated_provider_cost_micros is null)::text as unknown_calls
    from model_call_facts where account_id = ${fixture.accountId} group by provider, billing_path order by provider, billing_path`;
  const oracle = computeOracle(fixture.calls);
  const referenceCounts = await admin`
    select count(*) filter (where s.id is null)::text as "deletedSessionFacts",
      count(*) filter (where s.id is not null and t.id is null)::text as "invalidLiveTurnFacts",
      count(*) filter (where s.id is not null and (s.account_id <> f.account_id or s.workspace_id <> f.workspace_id))::text as "wrongWorkspaceFacts"
    from model_call_facts f left join sessions s on s.id = f.session_id
      left join session_turns t on t.id = f.turn_id and t.session_id = f.session_id
    where f.account_id = ${fixture.accountId}`;
  if (
    Number(referenceCounts[0]!.deletedSessionFacts) !== oracle.missingSessions ||
    referenceCounts[0]!.invalidLiveTurnFacts !== "0" ||
    referenceCounts[0]!.wrongWorkspaceFacts !== "0"
  ) {
    throw new Error("Fixture source-reference coherence mismatch");
  }
  const ledgerDistribution =
    await admin`select event_type, unit, count(*)::text as rows, sum(quantity)::text as quantity
    from usage_events where account_id = ${fixture.accountId} group by event_type, unit order by event_type, unit`;
  const ledgerReferences = await admin`
    select count(*) filter (where u.session_id is not null and s.id is null)::text as "deletedSessionUsage",
      count(*) filter (where s.id is not null and t.id is null)::text as "invalidLiveTurnUsage",
      count(*) filter (where s.id is not null and (s.account_id <> u.account_id or s.workspace_id <> u.workspace_id))::text as "wrongWorkspaceUsage"
    from usage_events u left join sessions s on s.id = u.session_id
      left join session_turns t on t.id = u.turn_id and t.session_id = u.session_id
    where u.account_id = ${fixture.accountId}`;
  if (
    ledgerReferences[0]!.invalidLiveTurnUsage !== "0" ||
    ledgerReferences[0]!.wrongWorkspaceUsage !== "0"
  )
    throw new Error("Fixture ledger-reference coherence mismatch");
  const debitDistribution =
    await admin`select source_type, count(*)::text as rows, (-sum(amount_micros))::text as "debitMicros"
    from credit_ledger_entries where account_id = ${fixture.accountId} and type = 'usage_debit'
    group by source_type order by source_type`;
  const expected = {
    factRows: fixture.calls,
    ledgerRows: oracle.costEvents + oracle.tokensEvents,
    chargedMicros: oracle.totals.ledgerMicros,
    debitMicros: oracle.creditDebits,
    factCreditMicros: oracle.totals.creditMicros,
    factTokens: oracle.totals.totalTokens,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number(counts![key]) !== value)
      throw new Error(`Independent fixture oracle mismatch: ${key}`);
  }
  return {
    counts,
    distribution,
    referenceCounts,
    ledgerDistribution,
    ledgerReferences,
    debitDistribution,
    debitPolicy:
      "Independently priced original charges settle by workspace/call batch; usage event dates remain per-call. Debits are never copied from analytical aggregates.",
    oracle,
    integrity: "independent original-call oracle matched raw facts, charges and debits",
  };
}
