import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0382_organization_api_key_provenance.sql",
  import.meta.url,
);

describe("migration 0382 organization API key provenance", () => {
  test("backfills historical keys and supports the previous writer during rollout", async () => {
    const source = await Bun.file(migrationUrl).text();

    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("ADD COLUMN credential_kind text;");
    expect(source).toContain("ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;");
    expect(source).toContain("WHEN workspace_id IS NOT NULL THEN 'workspace'");
    expect(source).toContain("ELSE 'legacy_account'");
    expect(source).toContain(
      "WHEN workspace_id IS NULL THEN COALESCE(revoked_at, CURRENT_TIMESTAMP)",
    );
    expect(source).toContain("ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;");
    expect(source).toContain(
      "CREATE FUNCTION opengeni_private.normalize_api_key_credential_kind()",
    );
    expect(source).toContain("ELSIF NEW.credential_kind IS NULL THEN");
    expect(source).toContain(
      `'["account:read","workspace:create","workspace:read","workspace:admin","api_keys:manage"]'::jsonb`,
    );
    expect(source).toContain(
      "IF NEW.credential_kind = 'legacy_account' AND NEW.revoked_at IS NULL THEN",
    );
    expect(source).toContain("NEW.revoked_at := CURRENT_TIMESTAMP;");
    expect(source).toContain("CREATE TRIGGER api_keys_00_normalize_credential_kind");
    expect(source).toContain("UPDATE OF workspace_id, credential_kind, permissions, revoked_at");
    expect(source).toContain("ALTER COLUMN credential_kind SET NOT NULL");
    expect(source).toContain("credential_kind = 'organization'");
    expect(source).toContain("credential_kind = 'legacy_account' AND revoked_at IS NOT NULL");
    expect(source).toContain("VALIDATE CONSTRAINT api_keys_credential_kind_check");
    expect(source).toContain("WHERE credential_kind = 'organization'");
    expect(source).not.toContain("UPDATE api_keys\nSET credential_kind = 'organization'");
  });
});
