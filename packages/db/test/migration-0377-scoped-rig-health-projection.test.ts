import { describe, expect, test } from "bun:test";

const migrationUrl = new URL("../drizzle/0377_scoped_rig_health_projection.sql", import.meta.url);

describe("migration 0377 scoped Rig health projection", () => {
  test("projects terminal active-version verification evidence without widening access", async () => {
    const source = await Bun.file(migrationUrl).text();

    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("CREATE OR REPLACE FUNCTION scoped_rig_json(p_rig_id uuid)");
    expect(source).toContain("LANGUAGE sql STABLE SECURITY DEFINER");
    expect(source).toContain("FROM rig_changes change");
    expect(source).toContain("FROM audit_events event");
    expect(source).toContain("'rig.verification.passed', 'rig.verification.failed'");
    expect(source).toContain("event.metadata ->> 'versionId' = active_version.id::text");
    expect(source).toContain("nullif(event.metadata ->> 'finishedAt', '')::timestamptz");
    expect(source).toContain("REVOKE ALL ON FUNCTION scoped_rig_json(uuid) FROM PUBLIC");
    expect(source).not.toContain(
      "jsonb_build_object('checkHealth', 'unknown', 'lastVerifiedAt', NULL)",
    );
    expect(source).not.toMatch(/\bALTER TABLE\b/u);
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
  });
});
