import { describe, expect, test } from "bun:test";

const unsafeMigrationUrl = new URL(
  "../drizzle/0377_scoped_rig_health_projection.sql",
  import.meta.url,
);
const repairMigrationUrl = new URL(
  "../drizzle/0378_scoped_rig_health_audit_timestamp.sql",
  import.meta.url,
);

describe("migration 0378 scoped Rig health audit timestamp", () => {
  test("repairs the ledgered 0377 projection without rewriting migration history", async () => {
    const [unsafeSource, repairSource] = await Promise.all([
      Bun.file(unsafeMigrationUrl).text(),
      Bun.file(repairMigrationUrl).text(),
    ]);

    expect(unsafeSource).toContain("nullif(event.metadata ->> 'finishedAt', '')::timestamptz");
    expect(repairSource).toStartWith("-- deployment-mode: rolling");
    expect(repairSource).toContain("CREATE OR REPLACE FUNCTION scoped_rig_json(p_rig_id uuid)");
    expect(repairSource).toContain("LANGUAGE sql STABLE SECURITY DEFINER");
    expect(repairSource).toContain("FROM audit_events event");
    expect(repairSource).toContain("event.occurred_at");
    expect(repairSource).not.toContain("event.metadata ->> 'finishedAt'");
    expect(repairSource).toContain("event.metadata ->> 'versionId' = active_version.id::text");
    expect(repairSource).toContain("REVOKE ALL ON FUNCTION scoped_rig_json(uuid) FROM PUBLIC");
    expect(repairSource).not.toMatch(/\bALTER TABLE\b/u);
    expect(repairSource).not.toMatch(/\bDROP TABLE\b/u);
  });
});
