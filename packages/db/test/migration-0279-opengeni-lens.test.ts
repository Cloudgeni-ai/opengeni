import { describe, expect, test } from "bun:test";

import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migration = await Bun.file(
  new URL("../drizzle/0279_opengeni_lens.sql", import.meta.url),
).text();

const tables = [
  "lens_app_registrations",
  "lens_repository_bindings",
  "lens_webhook_deliveries",
] as const;

describe("OpenGeni Lens migration", () => {
  test("is additive, rolling, and explicitly runtime-postured", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("keeps credentials encrypted and repository/delivery identities exact", () => {
    expect(migration).toContain('"credential_encrypted" text');
    expect(migration).toContain('"webhook_secret_encrypted" text NOT NULL');
    expect(migration).not.toMatch(/"(?:access_token|private_key|webhook_secret)"\s+text/iu);
    expect(migration).toContain("lens_app_registrations_credential_chk");
    expect(migration).toContain("lens_repository_bindings_registration_repo_uq");
    expect(migration).toContain("workspace_id_registration_provider_uq");
    expect(migration).toContain("lens_webhook_deliveries_registration_delivery_uq");
    expect(migration).toContain(
      'FOREIGN KEY ("workspace_id", "repository_binding_id", "registration_id", "provider")',
    );
    expect(migration).toContain("lens_webhook_deliveries_digest_chk");
    expect(migration).toContain("opengeni_private.workspace_rls_visible");
    expect(migration).toContain("CREATE POLICY session_visibility_isolation");
    expect(migration).toContain(
      'session_reference_visible("account_id", "workspace_id", "session_id")',
    );
  });
});
