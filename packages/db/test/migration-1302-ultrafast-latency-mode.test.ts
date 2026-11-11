import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatencyMode } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { seedPrefixLedgerSession } from "./helpers/prefix-ledger-session";

const FIRST = "1302_ultrafast_latency_mode_sessions.sql";
const MIGRATIONS = [
  FIRST,
  "1303_ultrafast_latency_mode_session_turns.sql",
  "1304_ultrafast_latency_mode_composer_drafts.sql",
  "1305_ultrafast_latency_mode_new_session_drafts.sql",
  "1306_ultrafast_scheduled_admission_latency_mode.sql",
  "1307_validate_ultrafast_latency_mode_sessions.sql",
  "1308_validate_ultrafast_latency_mode_session_turns.sql",
  "1309_validate_ultrafast_latency_mode_composer_drafts.sql",
  "1310_validate_ultrafast_latency_mode_new_session_drafts.sql",
];
const CONSTRAINTS = [
  ["sessions", "sessions_latency_mode_check"],
  ["session_turns", "session_turns_latency_mode_check"],
  ["composer_drafts", "composer_drafts_latency_mode_check"],
  ["new_session_drafts", "new_session_drafts_latency_mode_check"],
] as const;
const source = join(import.meta.dir, "../drizzle");
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string };
let existingSessionId: string;

async function constraints() {
  return Array.from(
    await owned!.admin<{ name: string; valid: boolean; definition: string }[]>`
      select c.conname as name,
        c.convalidated as valid, pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      where c.conname in ${owned!.admin(CONSTRAINTS.map(([, name]) => name))}
      order by c.conname`,
  );
}

function session(latencyMode: LatencyMode) {
  return createSession(client!.db, {
    ...scope,
    initialMessage: `a ${latencyMode} chat`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode,
    sandboxBackend: "none",
  });
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("ultrafast-latency-mode");
  if (!owned) throw new Error("Real PostgreSQL is required for the latency-mode migration");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-ultrafast-"));
  for (const name of await readdir(source))
    if (name.endsWith(".sql") && name < FIRST)
      await copyFile(join(source, name), join(prefix, name));
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "migration-1302",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "migration-1302",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Ultrafast migration",
    workspaceName: "Ultrafast migration",
    subjectId: "migration-1302",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  ({ sessionId: existingSessionId } = await seedPrefixLedgerSession(owned.admin, {
    ...scope,
    initialMessage: "a fast chat",
    latencyMode: "fast",
  }));
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1302-1310 Ultrafast latency mode", () => {
  test("are rolling migrations that add each check NOT VALID and validate it separately", async () => {
    for (const name of MIGRATIONS) {
      const text = await readFile(join(source, name), "utf8");
      expect(text).toStartWith("-- deployment-mode: rolling");
      expect(text).toContain("SET LOCAL lock_timeout = '5s';");
      expect(text).not.toMatch(/\bLOCK\s+TABLE\b|\bUPDATE\s+\w+\s+SET\b/i);
    }
    for (const name of MIGRATIONS.slice(0, 4)) {
      expect(await readFile(join(source, name), "utf8")).toContain("NOT VALID;");
    }
    for (const name of MIGRATIONS.slice(5)) {
      expect(await readFile(join(source, name), "utf8")).toContain("VALIDATE CONSTRAINT");
    }
  });

  test("before: Ultrafast is refused; after: every mode is accepted and existing rows validate", async () => {
    const before = await constraints();
    expect(before).toHaveLength(CONSTRAINTS.length);
    for (const { definition } of before) expect(definition).not.toContain("ultrafast");
    await expect(
      seedPrefixLedgerSession(owned!.admin, {
        ...scope,
        initialMessage: "an ultrafast chat",
        latencyMode: "ultrafast",
      }),
    ).rejects.toThrow("sessions_latency_mode_check");

    await migrate(owned!.ownerUrl);

    const after = await constraints();
    expect(after.map(({ name, valid }) => ({ name, valid }))).toEqual(
      CONSTRAINTS.map(([, name]) => name)
        .sort()
        .map((name) => ({ name, valid: true })),
    );
    for (const { definition } of after) {
      for (const mode of LatencyMode.options) expect(definition).toContain(`'${mode}'`);
    }
    for (const mode of LatencyMode.options) {
      expect((await session(mode)).latencyMode).toBe(mode);
    }
    const [existing] = await owned!.admin<{ latency_mode: string }[]>`
      select latency_mode from sessions where id = ${existingSessionId}`;
    expect(existing?.latency_mode).toBe("fast");
  }, 600_000);

  test("scheduled-run admission reads every mode from session metadata", async () => {
    const [row] = await owned!.admin<{ definition: string }[]>`
      select pg_get_functiondef('admit_scheduled_agent_run_execution()'::regprocedure) as definition`;
    expect(row?.definition).toContain(
      `IN (${LatencyMode.options.map((mode) => `'${mode}'`).join(",")})`,
    );
    expect(row?.definition).not.toContain("IN ('standard','priority','fast')");
  });
});
