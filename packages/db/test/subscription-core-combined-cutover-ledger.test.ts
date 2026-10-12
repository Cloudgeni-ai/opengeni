/**
 * The SuperGrok (0739) and Claude (0740) drained cutovers in one maintenance
 * window or in two (design 5.3 "Cutover protocol", ordering decision). The
 * ledger orders SuperGrok first; each cutover commits in its own transaction
 * and touches only its own provider, so:
 *
 * - one `migrate` applies both, each with its own receipt and report;
 * - a Claude abort in a combined window leaves SuperGrok cut over, and a
 *   rerun after the fix completes Claude;
 * - that rerun is safe only because nothing but rolling migrations lies
 *   between the two cutover ordinals (the ledger check below).
 *
 * The drained retirement (design 5.3 "R. Retirement") follows both and
 * requires both receipts: in a combined window it runs last, after the
 * cutovers commit, and a Claude abort stops the window before it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import {
  createDb,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  SUBSCRIPTION_RETIRED_ROUTINES,
  SUBSCRIPTION_RETIREMENT_MIGRATION,
} from "../src";
import { XAI_SUBSCRIPTION_CORE_CUTOVER_MIGRATION } from "../src/xai-subscription-core-cutover";
import { CLAUDE_SUBSCRIPTION_CORE_CUTOVER_MIGRATION } from "../src/claude-subscription-core-cutover";

const XAI = XAI_SUBSCRIPTION_CORE_CUTOVER_MIGRATION;
const CLAUDE = CLAUDE_SUBSCRIPTION_CORE_CUTOVER_MIGRATION;
const RETIREMENT = SUBSCRIPTION_RETIREMENT_MIGRATION;
const key = Buffer.alloc(32, 83);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const drizzle = new URL("../drizzle/", import.meta.url);

test("D-32: provider-keyed bindings precede the first drained provider cutover", async () => {
  const files = (await readdir(drizzle)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const bindings = files.findIndex((name) =>
    name.endsWith("_subscription_session_bindings_per_provider.sql"),
  );
  expect(bindings).toBeGreaterThanOrEqual(0);
  expect(bindings).toBeLessThan(files.indexOf(XAI));
  expect(bindings).toBeLessThan(files.indexOf(CLAUDE));
});

test("only rolling migrations lie between the SuperGrok and the Claude cutover", async () => {
  const files = (await readdir(drizzle)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const xai = files.indexOf(XAI);
  const claude = files.indexOf(CLAUDE);
  expect(xai).toBeGreaterThanOrEqual(0);
  // The ledger orders SuperGrok first.
  expect(claude).toBeGreaterThan(xai);
  for (const name of [XAI, CLAUDE]) {
    const first = (await readFile(new URL(name, drizzle), "utf8")).split("\n", 1)[0];
    expect(first).toBe("-- deployment-mode: maintenance");
  }
  for (const name of files.slice(xai + 1, claude)) {
    const first = (await readFile(new URL(name, drizzle), "utf8")).split("\n", 1)[0];
    expect(`${name}: ${first}`).toBe(`${name}: -- deployment-mode: rolling`);
  }
});

test("the drained retirement follows Claude and the reader-first shared-choice maintenance step", async () => {
  const files = (await readdir(drizzle)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const claude = files.indexOf(CLAUDE);
  const retirement = files.indexOf(RETIREMENT);
  expect(retirement).toBeGreaterThan(claude);
  const first = (await readFile(new URL(RETIREMENT, drizzle), "utf8")).split("\n", 1)[0];
  expect(first).toBe("-- deployment-mode: maintenance");
  const sharedChoice = "0741_subscription_shared_personal_choice.sql";
  expect(files.indexOf(sharedChoice)).toBeGreaterThan(claude);
  expect(files.indexOf(sharedChoice)).toBeLessThan(retirement);
  for (const name of files.slice(claude + 1, retirement)) {
    const line = (await readFile(new URL(name, drizzle), "utf8")).split("\n", 1)[0];
    const mode = name === sharedChoice ? "maintenance" : "rolling";
    expect(`${name}: ${line}`).toBe(`${name}: -- deployment-mode: ${mode}`);
  }
});

function xaiAccessToken(subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ principal_id: subject, exp: 4_102_444_800 }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

type Fixture = { account: string; workspace: string; xai: string; claude: string; legacy: string };

async function seed(owned: OwnerMigratedTestDatabase): Promise<Fixture> {
  const fixture = {
    account: randomUUID(),
    workspace: randomUUID(),
    xai: randomUUID(),
    claude: randomUUID(),
    legacy: randomUUID(),
  };
  const admin = owned.admin;
  await admin`INSERT INTO managed_accounts (id, name) VALUES (${fixture.account}, 'Combined window')`;
  await admin`INSERT INTO workspaces (id, account_id, name) VALUES (${fixture.workspace}, ${fixture.account}, 'Combined')`;
  await admin`INSERT INTO xai_subscription_credentials (id, account_id, workspace_id, authority_scope,
      credential_encrypted, provider_account_id, label, status, version)
    VALUES (${fixture.xai}, ${fixture.account}, ${fixture.workspace}, 'workspace',
      ${encryptEnvironmentValue(
        key,
        JSON.stringify({
          version: 1,
          accessToken: xaiAccessToken("sub-combined"),
          refreshToken: "refresh-xai",
        }),
      )}, 'sub-combined', 'SuperGrok', 'active', 2)`;
  const accountUuid = randomUUID();
  await admin`INSERT INTO claude_subscription_credentials (id, account_id, workspace_id, authority_scope,
      credential_encrypted, provider_account_id, label, status, version)
    VALUES (${fixture.claude}, ${fixture.account}, ${fixture.workspace}, 'workspace',
      ${encryptEnvironmentValue(
        key,
        JSON.stringify({
          version: 1,
          token: "sk-ant-oat01-combined",
          identity: { accountUuid, deviceId: "e".repeat(64) },
          oauth: {
            refreshToken: "refresh-claude",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            scopes: ["user:inference"],
          },
        }),
      )}, ${accountUuid}, 'Claude', 'active', 3)`;
  // A revoked legacy model connection, as 0598 left every one.
  await admin`INSERT INTO connections (id, account_id, workspace_id, provider_domain, kind,
      credential_encrypted, version, metadata, status)
    VALUES (${fixture.legacy}, ${fixture.account}, ${fixture.workspace}, 'api.anthropic.com', 'api_key',
      '', 1, '{"credentialRole":"claude_subscription"}'::jsonb, 'revoked')`;
  return fixture;
}

async function prepare(name: string) {
  const owned = await acquireOwnerMigratedTestDatabase(name);
  if (!owned) throw new Error("Real PostgreSQL required");
  const owner = postgres(owned.ownerUrl, { max: 1 });
  await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await owner`INSERT INTO schema_migrations(name) VALUES (${XAI}), (${CLAUDE}), (${RETIREMENT})`;
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await owner`DELETE FROM schema_migrations WHERE name IN (${XAI}, ${CLAUDE}, ${RETIREMENT})`;
  await owner.end();
  return { owned, fixture: await seed(owned) };
}

const runWindow = (owned: OwnerMigratedTestDatabase) =>
  migrate(owned.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    environmentsEncryptionKey: key,
  });

async function state(owned: OwnerMigratedTestDatabase) {
  const [row] = await owned.admin`SELECT
    opengeni_private.subscription_provider_cutover_committed('xai') AS xai_receipt,
    opengeni_private.subscription_provider_cutover_committed('claude') AS claude_receipt,
    (SELECT array_agg(name ORDER BY name) FROM schema_migrations
      WHERE name IN (${XAI}, ${CLAUDE}, ${RETIREMENT})) AS ledger,
    to_regprocedure('resolve_claude_authority_pool(uuid, uuid, text, jsonb)') IS NOT NULL AS legacy_routines,
    (SELECT count(*)::int FROM subscription_connections WHERE provider = 'xai') AS xai_connections,
    (SELECT count(*)::int FROM subscription_connections WHERE provider = 'claude') AS claude_connections,
    (SELECT count(*)::int FROM opengeni_private.subscription_cutover_report
      WHERE provider = 'xai' AND legacy_count IS DISTINCT FROM core_count) AS xai_mismatches,
    (SELECT count(*)::int FROM opengeni_private.subscription_cutover_report WHERE provider = 'claude') AS claude_report,
    (SELECT count(*)::int FROM opengeni_private.subscription_cutover_report
      WHERE provider = 'claude' AND legacy_count IS DISTINCT FROM core_count) AS claude_mismatches,
    (SELECT credential_encrypted = '' FROM claude_subscription_credentials LIMIT 1) AS claude_wiped`;
  return row!;
}

async function postureClean(owned: OwnerMigratedTestDatabase) {
  await provisionRoles(owned.adminUrl, { appRole: "opengeni_app", appPassword: owned.appPassword });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  const client = createDb(url.toString(), { max: 2 });
  try {
    const options = {
      rlsStrategy: "force" as const,
      expectedRole: "opengeni_app",
      targetSchema: "public",
    };
    const posture = await inspectRuntimeDatabasePosture(client.db, options);
    expect(posture.subscriptionProviderCutoverReceipts).toEqual(["claude", "codex", "xai"]);
    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
  } finally {
    await client.close();
  }
}

describe.skipIf(!realDb)("SuperGrok and Claude cutovers in one maintenance window", () => {
  let owned: OwnerMigratedTestDatabase;
  beforeAll(async () => {
    owned = (await prepare("combined-cutover-window")).owned;
  }, 180_000);
  afterAll(async () => {
    await owned?.release();
  }, 60_000);

  test("one migrate applies SuperGrok then Claude, each with its own receipt and parity report, then the retirement", async () => {
    await runWindow(owned);
    expect(await state(owned)).toMatchObject({
      xai_receipt: true,
      claude_receipt: true,
      ledger: [XAI, CLAUDE, RETIREMENT],
      legacy_routines: false,
      xai_connections: 1,
      claude_connections: 1,
      xai_mismatches: 0,
      claude_mismatches: 0,
      claude_wiped: true,
    });
    const [order] = await owned.admin`SELECT
      (SELECT committed_at FROM opengeni_private.subscription_provider_cutover_receipts WHERE provider = 'xai')
        <= (SELECT committed_at FROM opengeni_private.subscription_provider_cutover_receipts WHERE provider = 'claude')
        AS ordered`;
    expect(order!.ordered).toBe(true);
    // The retirement dropped every retired routine; the migrated rows stay.
    const retiredNames = (target: boolean) =>
      SUBSCRIPTION_RETIRED_ROUTINES.filter(({ schema }) => (schema === "target") === target).map(
        ({ signature }) => signature.slice(0, signature.indexOf("(")),
      );
    const [left] = await owned.admin`SELECT count(*)::int AS total FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE (n.nspname = 'public' AND p.proname = ANY(${retiredNames(true)}::text[]))
        OR (n.nspname IN ('opengeni_private', 'opengeni_subscription_internal')
          AND p.proname = ANY(${retiredNames(false)}::text[]))`;
    expect(left!.total).toBe(0);
    const [rows] = await owned.admin`SELECT
      (SELECT count(*)::int FROM xai_subscription_credentials) AS xai,
      (SELECT count(*)::int FROM claude_subscription_credentials) AS claude`;
    expect(rows).toEqual({ xai: 1, claude: 1 });
    await postureClean(owned);
  }, 300_000);
});

describe.skipIf(!realDb)("a Claude abort in a combined window", () => {
  let owned: OwnerMigratedTestDatabase;
  let fixture: Fixture;
  beforeAll(async () => {
    ({ owned, fixture } = await prepare("combined-cutover-abort"));
  }, 180_000);
  afterAll(async () => {
    await owned?.release();
  }, 60_000);

  test("leaves SuperGrok cut over and the retirement unapplied; the rerun after the fix completes Claude and the retirement", async () => {
    // A legacy Claude model connection that is not revoked aborts 0740 only.
    await owned.admin`ALTER TABLE connections DISABLE TRIGGER USER`;
    await owned.admin`UPDATE connections SET status = 'active' WHERE id = ${fixture.legacy}`;
    await owned.admin`ALTER TABLE connections ENABLE TRIGGER USER`;
    const error = await runWindow(owned).catch((caught: Error) => caught);
    expect((error as Error).message).toContain("legacy_connection_not_revoked");
    expect(await state(owned)).toMatchObject({
      xai_receipt: true,
      claude_receipt: false,
      ledger: [XAI],
      legacy_routines: true,
      xai_connections: 1,
      claude_connections: 0,
      xai_mismatches: 0,
      claude_report: 0,
      claude_wiped: false,
    });
    // The operator fixes the named rows and reruns the same release.
    await owned.admin`ALTER TABLE connections DISABLE TRIGGER USER`;
    await owned.admin`UPDATE connections SET status = 'revoked' WHERE id = ${fixture.legacy}`;
    await owned.admin`ALTER TABLE connections ENABLE TRIGGER USER`;
    await runWindow(owned);
    expect(await state(owned)).toMatchObject({
      xai_receipt: true,
      claude_receipt: true,
      ledger: [XAI, CLAUDE, RETIREMENT],
      legacy_routines: false,
      xai_connections: 1,
      claude_connections: 1,
      xai_mismatches: 0,
      claude_mismatches: 0,
      claude_wiped: true,
    });
    await postureClean(owned);
  }, 300_000);
});
