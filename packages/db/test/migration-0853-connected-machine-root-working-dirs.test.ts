import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createEnrollment, createSandbox, createSession, type DbClient } from "../src";
import { executeMigrationFile, migrate } from "../src/migrate";

const migrationFile = "0853_connected_machine_root_working_dirs.sql";
const migration = await readFile(new URL(`../drizzle/${migrationFile}`, import.meta.url), "utf8");
let owned: OwnerMigratedTestDatabase;
let admin: postgres.Sql;
let owner: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("migration-0853-working-dirs");
  if (!acquired) throw new Error("Real PostgreSQL required");
  owned = acquired;
  await migrate(owned.ownerUrl);
  admin = owned.admin;
  owner = postgres(owned.ownerUrl, { max: 1 });
  client = createDb(owned.adminUrl);
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
}, 60_000);

test("clears only a saved filesystem root or Windows system32 launch directory", async () => {
  const db = client.db;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  const accountId = account!.id;
  const workspaceId = workspace!.id;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspaceId}, ${accountId})`;

  const machine = async (name: string, workspaceRoot: string) => {
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${name}`,
      hasDisplay: false,
    });
    await admin`update enrollments set workspace_root = ${workspaceRoot} where id = ${enrollment.id}`;
    return await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name,
      enrollmentId: enrollment.id,
    });
  };
  const mac = await machine("mac", "/Users/user");
  const linux = await machine("linux", "/home/u");
  const windows = await machine("windows", "C:/Users/user");

  const session = async (workingDir: string, sandboxId: string | null) => {
    const created = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "selfhosted",
    });
    await admin`
      update sessions set working_dir = ${workingDir}, active_sandbox_id = ${sandboxId}
      where id = ${created.id}`;
    return created.id;
  };
  const cases = {
    filesystemRoot: { id: await session("/", mac.id), after: null },
    windowsSystem: { id: await session("C:/WINDOWS/system32", windows.id), after: null },
    windowsSystemBackslash: {
      id: await session("c:\\Windows\\System32\\", windows.id),
      after: null,
    },
    machineRoot: { id: await session("/home/u", linux.id), after: "/home/u" },
    windowsHome: { id: await session("C:/Users/user", windows.id), after: "C:/Users/user" },
    windowsSubfolder: {
      id: await session("C:/Windows/system32/drivers", windows.id),
      after: "C:/Windows/system32/drivers",
    },
    chosenDirectory: { id: await session("/home/u/proj", linux.id), after: "/home/u/proj" },
    noMachine: { id: await session("/tmp", null), after: "/tmp" },
  };

  // Run as the production migration principal: a NOSUPERUSER/NOBYPASSRLS
  // owner, for whom FORCE RLS and the workspace fence trigger both engage.
  await owner.begin(async (tx) => {
    await executeMigrationFile(tx as unknown as postgres.Sql, migrationFile, migration);
  });

  for (const [name, { id, after }] of Object.entries(cases)) {
    const [row] = await admin<{ working_dir: string | null }[]>`
      select working_dir from sessions where id = ${id}`;
    expect({ name, workingDir: row!.working_dir }).toEqual({ name, workingDir: after });
  }
  const [rls] = await admin<{ force: boolean }[]>`
    select relforcerowsecurity as force from pg_class where relname = 'sessions'`;
  expect(rls!.force).toBe(true);
  const [fence] = await admin<{ enabled: string }[]>`
    select tgenabled as enabled from pg_trigger
    where tgname = 'session_tenancy_workspace_fence' and tgrelid = 'sessions'::regclass`;
  expect(fence!.enabled).toBe("O");
}, 120_000);
