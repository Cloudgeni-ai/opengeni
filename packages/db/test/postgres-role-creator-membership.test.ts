import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { assertRuntimeDatabasePosture, createDb, type Database, type DbClient } from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const PORT = 61442;
const CONTAINER = `ogverify-pg-role-creator-${PORT}`;
const IMAGE = "pgvector/pgvector:pg17";
const ROOT_PASSWORD = "opengeni-role-root";
const ADMIN_ROLE = "opengeni_managed_admin";
const ADMIN_PASSWORD = "opengeni-managed-admin";
const APP_ROLE = "opengeni_app";
const APP_PASSWORD = "opengeni-app";
const DATABASE = "opengeni_role_creator";
const EXTERNAL_ROOT_URL = process.env.OPENGENI_TEST_THROWAWAY_POSTGRES_ROOT_URL?.trim();
const ROOT_URL =
  EXTERNAL_ROOT_URL || `postgres://postgres:${ROOT_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const USE_DOCKER_HOST_NETWORK = process.env.OPENGENI_TEST_DOCKER_HOST_NETWORK === "1";

function roleUrl(role: string, value: string, database: string): string {
  const root = new URL(ROOT_URL);
  return `${root.protocol}//${encodeURIComponent(role)}:${encodeURIComponent(value)}@${root.host}/${encodeURIComponent(database)}${root.search}${root.hash}`;
}

const ADMIN_URL = roleUrl(ADMIN_ROLE, ADMIN_PASSWORD, DATABASE);
const APP_URL = roleUrl(APP_ROLE, APP_PASSWORD, DATABASE);

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", "-v", CONTAINER]);
  } catch {
    // Already absent.
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ROOT_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`select 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(error)}`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;
let root: postgres.Sql;
let runtimeClient: DbClient;
let runtimeDb: Database;

beforeAll(async () => {
  if (!EXTERNAL_ROOT_URL) {
    try {
      removeContainer();
      docker([
        "run",
        "--rm",
        "-d",
        "-e",
        `POSTGRES_PASSWORD=${ROOT_PASSWORD}`,
        ...(USE_DOCKER_HOST_NETWORK ? ["--network", "host"] : ["-p", `${PORT}:5432`]),
        "--name",
        CONTAINER,
        IMAGE,
        ...(USE_DOCKER_HOST_NETWORK ? ["postgres", "-c", `port=${PORT}`] : []),
      ]);
    } catch (error) {
      available = false;
      console.warn(`[role-creator-membership] docker unavailable, skipping: ${String(error)}`);
      return;
    }
  }

  await waitForReady();
  root = postgres(ROOT_URL, { max: 2 });
  if (EXTERNAL_ROOT_URL) {
    await root.unsafe(`drop database if exists ${quoteIdentifier(DATABASE)} with (force)`);
    await root.unsafe(`drop role if exists ${quoteIdentifier(APP_ROLE)}`);
    await root.unsafe(`drop role if exists ${quoteIdentifier(ADMIN_ROLE)}`);
  }
  await root.unsafe(
    `create role ${quoteIdentifier(ADMIN_ROLE)} login password ${quoteLiteral(ADMIN_PASSWORD)} nosuperuser createrole nocreatedb noreplication nobypassrls`,
  );
  await root.unsafe(
    `create database ${quoteIdentifier(DATABASE)} owner ${quoteIdentifier(ADMIN_ROLE)}`,
  );

  const databaseRootUrl = new URL(ROOT_URL);
  databaseRootUrl.pathname = `/${DATABASE}`;
  const databaseRoot = postgres(databaseRootUrl.toString(), { max: 1 });
  try {
    await databaseRoot.unsafe("create extension if not exists vector");
    await databaseRoot.unsafe("create extension if not exists pgcrypto");
  } finally {
    await databaseRoot.end();
  }

  await migrate(ADMIN_URL);
  await provisionRoles(ADMIN_URL, {
    rlsStrategy: "force",
    appRole: APP_ROLE,
    appPassword: APP_PASSWORD,
  });
  runtimeClient = createDb(APP_URL, { max: 1, rlsStrategy: "force" });
  runtimeDb = runtimeClient.db;
}, 180_000);

afterAll(async () => {
  try {
    await runtimeClient?.close();
  } catch {
    // No-op.
  }
  if (EXTERNAL_ROOT_URL && root) {
    try {
      await root.unsafe(`drop database if exists ${quoteIdentifier(DATABASE)} with (force)`);
      await root.unsafe(`drop role if exists ${quoteIdentifier(APP_ROLE)}`);
      await root.unsafe(`drop role if exists ${quoteIdentifier(ADMIN_ROLE)}`);
    } catch {
      // The caller supplied a disposable cluster; preserve the original test failure.
    }
  }
  try {
    await root?.end();
  } catch {
    // No-op.
  }
  if (!EXTERNAL_ROOT_URL) removeContainer();
});

describe("PostgreSQL 16+ CREATEROLE creator membership", () => {
  test("permits only the automatic non-runtime-bearing management edge", async () => {
    if (!available) return;

    const [server] = await root<{ server_version_num: number }[]>`
      select current_setting('server_version_num')::integer as server_version_num
    `;
    expect(server!.server_version_num).toBeGreaterThanOrEqual(160000);

    const [automaticGrant] = await root<
      {
        admin_option: boolean;
        inherit_option: boolean;
        set_option: boolean;
        member_is_superuser: boolean;
        member_can_create_role: boolean;
        grantor_is_superuser: boolean;
      }[]
    >`
      select
        membership.admin_option,
        membership.inherit_option,
        membership.set_option,
        member.rolsuper as member_is_superuser,
        member.rolcreaterole as member_can_create_role,
        grantor.rolsuper as grantor_is_superuser
      from pg_auth_members membership
      join pg_roles parent on parent.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      join pg_roles grantor on grantor.oid = membership.grantor
      where parent.rolname = ${APP_ROLE}
        and member.rolname = ${ADMIN_ROLE}
    `;
    expect(automaticGrant).toEqual({
      admin_option: true,
      inherit_option: false,
      set_option: false,
      member_is_superuser: false,
      member_can_create_role: true,
      grantor_is_superuser: true,
    });

    const repeatedProvision = await provisionRoles(ADMIN_URL, {
      rlsStrategy: "force",
      appRole: APP_ROLE,
      appPassword: APP_PASSWORD,
    });
    expect(repeatedProvision).toMatchObject({ appRole: APP_ROLE });

    const posture = await assertRuntimeDatabasePosture(runtimeDb, {
      rlsStrategy: "force",
      expectedRole: APP_ROLE,
    });
    expect(posture.memberships).toEqual([]);
  }, 60_000);

  test("a non-superuser administrator fails closed on protected app-role attributes", async () => {
    if (!available) return;

    await root.unsafe(`alter role ${quoteIdentifier(APP_ROLE)} createdb`);
    await expect(
      provisionRoles(ADMIN_URL, {
        rlsStrategy: "force",
        appRole: APP_ROLE,
        appPassword: APP_PASSWORD,
      }),
    ).rejects.toThrow("cannot clear protected attributes (CREATEDB)");
    await root.unsafe(`alter role ${quoteIdentifier(APP_ROLE)} nocreatedb`);
  }, 60_000);

  test("provisioning and runtime posture reject a privilege-bearing reverse edge", async () => {
    if (!available) return;

    await root.unsafe(
      `grant ${quoteIdentifier(APP_ROLE)} to ${quoteIdentifier(ADMIN_ROLE)} with inherit true, set false`,
    );

    await expect(
      provisionRoles(ADMIN_URL, {
        rlsStrategy: "force",
        appRole: APP_ROLE,
        appPassword: APP_PASSWORD,
      }),
    ).rejects.toThrow(`remove privilege-bearing role relationships first (member:${ADMIN_ROLE})`);

    await expect(
      assertRuntimeDatabasePosture(runtimeDb, {
        rlsStrategy: "force",
        expectedRole: APP_ROLE,
      }),
    ).rejects.toThrow(`runtime role has memberships: member:${ADMIN_ROLE}`);
  }, 60_000);
});
