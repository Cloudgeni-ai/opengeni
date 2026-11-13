/**
 * Migration 1377's managed-workspace backfill, run as the NOSUPERUSER
 * NOBYPASSRLS migration owner so FORCE RLS binds exactly as in a release:
 * product workspaces (an external source set by an integration) are marked;
 * sign-in, Opengeni-created and personal workspaces are not.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { bootstrapWorkspace, createDb, listManagedWorkspaceMarkers, type DbClient } from "../src";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("console-backfill", "console_data");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { max: 2, searchPath: fixture.schema });
}, 240_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

test("the backfill marks product workspaces only", async () => {
  if (!fixture || !client) return;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Tech",
    workspaceExternalSource: "better-auth:user",
    workspaceExternalId: suffix,
    workspaceName: "Default workspace",
    subjectId: `user:${suffix}`,
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const implementationId = access.workspaceGrants[0]!.workspaceId!;
  const productIds = Array.from({ length: 12 }, () => crypto.randomUUID());
  const addedDefaultId = crypto.randomUUID();
  const personalId = crypto.randomUUID();
  await fixture.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const [index, id] of productIds.entries()) {
      await tx`insert into workspaces (id, account_id, name, external_source, external_id)
        values (${id}, ${accountId}, ${`kontali-dev:${index}`}, 'kontali-edge-dev', ${String(index)})`;
    }
    await tx`insert into workspaces (id, account_id, name, external_source, external_id) values
      (${addedDefaultId}, ${accountId}, 'Default', 'opengeni:additional-organization-default', ${suffix}),
      (${personalId}, ${accountId}, 'Personal', 'kontali-edge-dev', ${`personal-${suffix}`})`;
    await tx`insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${accountId}, ${`external_user:${suffix}`}, 'member', 'active', ${personalId})`;
  });

  const migration = await Bun.file(
    new URL("../drizzle/1377_opengeni_console.sql", import.meta.url),
  ).text();
  const start = migration.indexOf("DO $opengeni_console_backfill$");
  const marker = "$opengeni_console_backfill$;";
  const end = migration.indexOf(marker, start) + marker.length;
  const owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await owner.begin(async (tx) => {
      await tx`select set_config('search_path', ${fixture!.schema}, true)`;
      await tx.unsafe(migration.slice(start, end));
    });
  } finally {
    await owner.end();
  }

  const markers = await listManagedWorkspaceMarkers(client.db, accountId);
  // More candidates than one cursor fetch: every product workspace is marked.
  expect([...markers.keys()].sort()).toEqual([...productIds].sort());
  expect(markers.has(implementationId)).toBe(false);
  expect(markers.has(addedDefaultId)).toBe(false);
  expect(markers.has(personalId)).toBe(false);
}, 120_000);
