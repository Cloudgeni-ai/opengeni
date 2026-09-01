import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { migrate } from "../src/migrate";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let admin: ReturnType<typeof postgres> | null = null;
let app: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("local_organization_administration");
  if (!shared) {
    available = false;
    console.warn("[local-organization-administration] docker unavailable, skipping");
    return;
  }
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
  admin = postgres(shared.adminUrl, { max: 1 });
  app = postgres(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0386 local organization administration", () => {
  test("keeps the local exception exact and restores forced RLS", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0386_local_organization_administration.sql", import.meta.url),
    ).text();
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("account.external_source = 'opengeni:local'");
    expect(source).toContain("account.external_id = 'default'");
    expect(source).toContain("NEW.subject_id = 'dev'");
    expect(source).toContain("membership.authorization_revision + 1");
    expect(source).toContain("ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY");
    expect(source).toContain(
      "ALTER FUNCTION opengeni_private.assign_managed_self_organization_owner() SET search_path = pg_catalog, %I, pg_temp",
    );
    expect(source).toContain("subject_value LIKE 'user:%%'");
    expect(source).not.toContain("subject_value LIKE 'dev%'");
  });

  test("bootstraps the exact local user as owner with organization Codex visibility", async () => {
    if (!available || !admin || !app) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: "default",
      accountName: "OpenGeni Local",
      workspaceExternalSource: "opengeni:local",
      workspaceExternalId: "default",
      workspaceName: "Local workspace",
      subjectId: "dev",
      subjectLabel: "Local user",
    });
    const accountId = access.defaultAccountId;
    if (!accountId) throw new Error("local account was not returned");

    const [membership] = await admin<
      {
        role: string;
        status: string;
        authorization_revision: number;
      }[]
    >`
      select role, status, authorization_revision
      from organization_memberships
      where account_id = ${accountId} and subject_id = 'dev'
    `;
    expect(membership).toMatchObject({ role: "owner", status: "active" });

    await app`select set_config('opengeni.account_id', ${accountId}, false)`;
    await app`select set_config('opengeni.workspace_id', '', false)`;
    await app`select set_config('opengeni.subject_id', 'dev', false)`;
    const [visible] = await app<{ allowed: boolean }[]>`
      select opengeni_private.codex_organization_scope_visible(${accountId}) as allowed
    `;
    expect(visible?.allowed).toBe(true);

    await app`select set_config('opengeni.subject_id', 'dev-delegated', false)`;
    const [rejected] = await app<{ allowed: boolean }[]>`
      select opengeni_private.codex_organization_scope_visible(${accountId}) as allowed
    `;
    expect(rejected?.allowed).toBe(false);
  }, 60_000);
});
