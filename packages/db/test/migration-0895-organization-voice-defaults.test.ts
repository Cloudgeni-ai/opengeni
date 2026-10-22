// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

import {
  createDb,
  getOrganizationModelDefaults,
  organizationModelProviderConnectionActiveForWorkspace,
  updateOrganizationModelDefaults,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0895_organization_voice_defaults.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0895-organization-voice-defaults");
  if (!shared) throw new Error("migration 0895 requires real PostgreSQL");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0895 organization voice defaults", () => {
  test("is a rolling widening with no row rewrite or RLS window", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS realtime_voice jsonb NOT NULL DEFAULT");
    expect(migration).not.toContain("organization_model_provider_custom_models");
    expect(migration).not.toContain("NO FORCE ROW LEVEL SECURITY");
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/imu);
  });

  test("admits an organization ElevenLabs key and keeps voice defaults by model", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('voice-defaults-test') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;

    // The insert fires the `model.connected` lifecycle capture, which rejects
    // an attribute outside product_lifecycle_fact_valid.
    const connected = await upsertOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "elevenlabs",
      credentialEncrypted: "encrypted-test-key",
      credentialDigest: "credential-digest",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    expect(connected).toMatchObject({ providerKind: "elevenlabs", status: "active", version: 1 });
    expect(
      await organizationModelProviderConnectionActiveForWorkspace(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "elevenlabs",
      }),
    ).toBe(true);

    expect((await getOrganizationModelDefaults(client.db, account!.id)).realtimeVoice).toEqual({});
    const actor = { organizationId: account!.id, actorSubjectId: owner };
    await updateOrganizationModelDefaults(client.db, {
      ...actor,
      patch: {
        realtimeVoice: {
          "workspace-elevenlabs/eleven_realtime_v1_max": { voice: "george", language: "nb" },
          "codex-live": { turnEagerness: "low" },
        },
      },
    });
    // Each model merges on its own; null and {} reset just that model.
    const updated = await updateOrganizationModelDefaults(client.db, {
      ...actor,
      patch: { realtimeVoice: { "codex-live": null } },
    });
    expect(updated.realtimeVoice).toEqual({
      "workspace-elevenlabs/eleven_realtime_v1_max": { voice: "george", language: "nb" },
    });
    // A malformed stored entry reads as unset without dropping the others.
    await shared.admin`
      update organization_model_defaults
      set realtime_voice = realtime_voice || '{"broken": {"voice": 7}}'::jsonb
      where account_id = ${account!.id}`;
    expect((await getOrganizationModelDefaults(client.db, account!.id)).realtimeVoice).toEqual({
      "workspace-elevenlabs/eleven_realtime_v1_max": { voice: "george", language: "nb" },
    });

    const [lifecycle] = await shared.admin<{ valid: boolean }[]>`
      select opengeni_private.product_lifecycle_fact_valid('model.connected', 'elevenlabs') as valid`;
    expect(lifecycle).toEqual({ valid: true });
  });
});
