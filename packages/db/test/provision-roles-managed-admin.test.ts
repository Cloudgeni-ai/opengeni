import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { provisionRoles } from "../src/provision-roles";

const PORT = 61445;
const CONTAINER = `ogverify-pg-managed-role-${PORT}`;
const SUPERUSER_PASSWORD = "superpw";
const ADMIN_ROLE = "managed_admin";
const ADMIN_PASSWORD = "adminpw";
const DATABASE = "managed_role_test";
const APP_ROLE = "opengeni_app";
const APP_PASSWORD = "apppw";
const IMAGE = "pgvector/pgvector:pg17";
const SUPERUSER_URL = `postgres://postgres:${SUPERUSER_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const ADMIN_URL = `postgres://${ADMIN_ROLE}:${ADMIN_PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
const APP_URL = `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", "-v", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(SUPERUSER_URL, { max: 1, connect_timeout: 2 });
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
      await Bun.sleep(500);
    }
  }
}

let available = true;
let dockerStarted = false;

beforeAll(async () => {
  try {
    removeContainer();
    docker([
      "run",
      "--rm",
      "-d",
      "-e",
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      "-p",
      `${PORT}:5432`,
      "--name",
      CONTAINER,
      IMAGE,
    ]);
    dockerStarted = true;
  } catch (error) {
    available = false;
    console.warn(`[managed-role] docker unavailable, skipping: ${String(error)}`);
    return;
  }

  await waitForReady();
  const control = postgres(SUPERUSER_URL, { max: 1 });
  try {
    await control.unsafe(
      `create role "${ADMIN_ROLE}" with login createrole password '${ADMIN_PASSWORD}'`,
    );
    await control.unsafe(`create database "${DATABASE}" owner "${ADMIN_ROLE}"`);
  } finally {
    await control.end();
  }
}, 90_000);

afterAll(() => {
  if (dockerStarted) {
    removeContainer();
  }
});

describe("managed Postgres role provisioning", () => {
  test("accepts only the implicit PostgreSQL 16+ creator administration edge", async () => {
    if (!available) return;

    const options = {
      targetSchema: "opengeni",
      rlsStrategy: "force" as const,
      appRole: APP_ROLE,
      appPassword: APP_PASSWORD,
    };

    await provisionRoles(ADMIN_URL, options);
    await provisionRoles(ADMIN_URL, options);

    const app = postgres(APP_URL, { max: 1 });
    try {
      const identity = await app<{ current_user: string }[]>`select current_user::text`;
      expect(identity[0]?.current_user).toBe(APP_ROLE);
    } finally {
      await app.end();
    }

    const control = postgres(SUPERUSER_URL, { max: 1 });
    try {
      const creatorEdges = await control<
        {
          member_role: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
        }[]
      >`
        select
          member.rolname::text as member_role,
          membership.admin_option,
          membership.inherit_option,
          membership.set_option
        from pg_auth_members membership
        join pg_roles member on member.oid = membership.member
        join pg_roles parent on parent.oid = membership.roleid
        where parent.rolname = ${APP_ROLE}
      `;
      expect([...creatorEdges]).toEqual([
        {
          member_role: ADMIN_ROLE,
          admin_option: true,
          inherit_option: false,
          set_option: false,
        },
      ]);

      await control.unsafe(`create role "unexpected_app_member"`);
      await control.unsafe(`grant "${APP_ROLE}" to "unexpected_app_member"`);
    } finally {
      await control.end();
    }

    await expect(provisionRoles(ADMIN_URL, options)).rejects.toThrow(
      "remove role relationships first (member:unexpected_app_member)",
    );

    const privilegedControl = postgres(SUPERUSER_URL, { max: 1 });
    try {
      await privilegedControl.unsafe(`revoke "${APP_ROLE}" from "unexpected_app_member"`);
      await privilegedControl.unsafe(`alter role "${APP_ROLE}" with createrole`);
    } finally {
      await privilegedControl.end();
    }

    await expect(provisionRoles(ADMIN_URL, options)).rejects.toThrow(
      "a non-superuser role administrator cannot remove existing privileged attributes",
    );
  }, 90_000);
});
