// Regression tests for the scratch bypass-role cleanup used by
// sandbox-lease.test.ts. Every role and database here carries a unique
// prefix, so nothing touches other runs' roles on a shared cluster.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import postgres from "postgres";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing/shared-pg";

import { dropScratchBypassRole, reapStaleBypassRoles } from "./scratch-bypass-role";

const hex = (length: number) => crypto.randomUUID().replaceAll("-", "").slice(0, length);
const scope = `sbr${hex(8)}`;
const quote = (name: string) => `"${name}"`;

let blank: BlankTestDatabase | null = null;
let adminUrl = "";
let admin: postgres.Sql | null = null;
const databases: string[] = [];

function urlFor(database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(name: string): Promise<string> {
  await admin!.unsafe(`CREATE DATABASE ${quote(name)}`);
  databases.push(name);
  return name;
}

async function grantIn(database: string, role: string): Promise<void> {
  const sql = postgres(urlFor(database), { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS probe (id int)`);
    await sql.unsafe(`GRANT SELECT ON probe TO ${quote(role)}`);
  } finally {
    await sql.end();
  }
}

async function roleExists(name: string): Promise<boolean> {
  return (await admin!`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).length > 0;
}

async function memberships(name: string): Promise<number> {
  const [row] = await admin!<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
     WHERE g.rolname = ${name} OR r.rolname = ${name}`;
  return row?.n ?? 0;
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("scratch-bypass-role");
  if (!blank) return;
  const url = new URL(blank.databaseUrl);
  url.pathname = "/postgres";
  adminUrl = url.toString();
  admin = postgres(adminUrl, { max: 2, onnotice: () => undefined });
  // The group stands in for opengeni_app, the member for a role granted it.
  await admin.unsafe(`CREATE ROLE ${quote(`${scope}_group`)} NOLOGIN`);
  await admin.unsafe(`CREATE ROLE ${quote(`${scope}_member`)} NOLOGIN`);
}, 180_000);

afterAll(async () => {
  try {
    if (admin) {
      for (const name of databases) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`).catch(() => {});
      }
      const roles = await admin<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles WHERE starts_with(rolname, ${scope})`;
      for (const { rolname } of roles) {
        await admin.unsafe(`DROP ROLE IF EXISTS ${quote(rolname)}`).catch(() => {});
      }
    }
  } finally {
    await admin?.end().catch(() => {});
    await blank?.release();
  }
}, 180_000);

describe("scratch bypass role cleanup", () => {
  test("drops a role that holds memberships both ways and grants in several og_ databases", async () => {
    if (!admin) return;
    const role = `${scope}_bypass_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(role)} LOGIN BYPASSRLS`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(role)}`);
    await admin.unsafe(`GRANT ${quote(role)} TO ${quote(`${scope}_member`)}`);
    // Grants the way a migration run elsewhere copies them to the role.
    const first = await createDatabase(`og_${scope}_a_${hex(12)}`);
    const second = await createDatabase(`og_${scope}_b_${hex(12)}`);
    for (const database of [first, second]) await grantIn(database, role);
    // A plain DROP ROLE fails while those grants exist.
    const plainDrop = await admin.unsafe(`DROP ROLE ${quote(role)}`).then(
      () => "dropped",
      (error: unknown) => String(error),
    );
    expect(plainDrop).toContain("depend");

    expect(await dropScratchBypassRole(admin, adminUrl, role)).toEqual([]);
    expect(await roleExists(role)).toBe(false);
    // The group and member roles stay, without the memberships.
    expect(await roleExists(`${scope}_group`)).toBe(true);
    expect(await roleExists(`${scope}_member`)).toBe(true);
    expect(await memberships(`${scope}_member`)).toBe(0);
  }, 120_000);

  test("never touches databases outside og_, but still removes the memberships", async () => {
    if (!admin) return;
    const role = `${scope}_bypass_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(role)}`);
    const outside = await createDatabase(`${scope}_outside`);
    await grantIn(outside, role);

    const notes = await dropScratchBypassRole(admin, adminUrl, role);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${role}: dropping`);
    expect(await roleExists(role)).toBe(true);
    expect(await memberships(role)).toBe(0);
    const [grant] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_shdepend s
        JOIN pg_database d ON d.oid = s.dbid JOIN pg_roles r ON r.oid = s.refobjid
       WHERE d.datname = ${outside} AND r.rolname = ${role}`;
    expect(grant?.n).toBe(1);
  }, 120_000);

  test("reaps only stale roles: one with a connection is kept", async () => {
    if (!admin) return;
    const pattern = `^${scope}_stale_[0-9a-f]{32}$`;
    const stale = `${scope}_stale_${hex(32)}`;
    const live = `${scope}_stale_${hex(32)}`;
    const password = hex(32);
    await admin.unsafe(`CREATE ROLE ${quote(stale)} NOLOGIN`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(stale)}`);
    await admin.unsafe(`CREATE ROLE ${quote(live)} LOGIN PASSWORD '${password}'`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(live)}`);
    // An idle role whose owner record names a live process here.
    const owned = `${scope}_stale_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(owned)} NOLOGIN`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(owned)}`);
    const record = `opengeni-test-db:v1 ${JSON.stringify({ host: hostname(), pid: process.pid })}`;
    await admin.unsafe(`COMMENT ON ROLE ${quote(owned)} IS '${record}'`);
    // A grant-only leftover no longer breaks anyone: left for later.
    const grantOnly = `${scope}_stale_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(grantOnly)} NOLOGIN`);
    await grantIn(await createDatabase(`og_${scope}_g_${hex(12)}`), grantOnly);
    const url = new URL(adminUrl);
    url.username = live;
    url.password = password;
    const holder = postgres(url.toString(), { max: 1 });
    try {
      await holder`SELECT 1`;
      expect(await reapStaleBypassRoles(admin, adminUrl, { pattern, recheckMs: 200 })).toEqual([
        stale,
      ]);
      expect(await roleExists(stale)).toBe(false);
      expect(await roleExists(live)).toBe(true);
      expect(await memberships(live)).toBe(1);
      expect(await roleExists(owned)).toBe(true);
      expect(await memberships(owned)).toBe(1);
      expect(await roleExists(grantOnly)).toBe(true);
    } finally {
      await holder.end();
    }
  }, 120_000);

  test("keeps a role that owns objects, and stops at its deadline", async () => {
    if (!admin) return;
    const owner = `${scope}_bypass_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(owner)} NOLOGIN`);
    await admin.unsafe(`GRANT ${quote(`${scope}_group`)} TO ${quote(owner)}`);
    const database = await createDatabase(`og_${scope}_o_${hex(12)}`);
    const sql = postgres(urlFor(database), { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`CREATE TABLE kept (id int)`);
      await sql.unsafe(`ALTER TABLE kept OWNER TO ${quote(owner)}`);
    } finally {
      await sql.end();
    }
    const notes = await dropScratchBypassRole(admin, adminUrl, owner);
    expect(notes).toEqual([`${owner}: owns objects in ${database}`]);
    expect(await roleExists(owner)).toBe(true);
    expect(await memberships(owner)).toBe(0);

    const late = `${scope}_bypass_${hex(32)}`;
    await admin.unsafe(`CREATE ROLE ${quote(late)} NOLOGIN`);
    await grantIn(database, late);
    const lateNotes = await dropScratchBypassRole(admin, adminUrl, late, {
      deadline: Date.now() - 1,
    });
    expect(lateNotes[0]).toBe(`${late}: out of time before ${database}`);
    expect(await roleExists(late)).toBe(true);
  }, 120_000);

  test("errors are reported, never thrown", async () => {
    // Nothing listens on port 1.
    const unreachable = postgres("postgres://postgres:x@127.0.0.1:1/postgres", {
      max: 1,
      connect_timeout: 2,
    });
    try {
      const notes = await dropScratchBypassRole(
        unreachable,
        "postgres://postgres:x@127.0.0.1:1/postgres",
        `${scope}_bypass_${hex(32)}`,
      );
      expect(notes.length).toBeGreaterThan(0);
      expect(
        await reapStaleBypassRoles(unreachable, "postgres://postgres:x@127.0.0.1:1/postgres", {
          recheckMs: 10,
        }),
      ).toEqual([]);
    } finally {
      await unreachable.end().catch(() => {});
    }
  }, 60_000);
});
