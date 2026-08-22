import { describe, expect, test } from "bun:test";
import {
  FORCE_RLS_TABLES,
  NON_RLS_RUNTIME_TABLES,
  RUNTIME_FULL_DML_TABLES,
} from "../src/runtime-posture";

const tenantTables = [
  "automation_sources",
  "automation_triggers",
  "automation_trigger_revisions",
  "automation_trigger_events",
  "automation_runs",
  "automation_run_event_links",
] as const;

describe("migration 0319 event-triggered automations", () => {
  test("pins authentication, occurrence idempotency, authority, and RLS boundaries", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0319_event_triggered_automations.sql", import.meta.url),
    ).text();
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("automation_sources_endpoint_uq");
    expect(source).toContain("automation_trigger_events_source_delivery_uq");
    expect(source).toContain("automation_runs_trigger_occurrence_uq");
    expect(source).toContain("automation_runs_trigger_source_fk");
    expect(source).toContain("automation_runs_event_fk");
    expect(source).toContain("automation_triggers_pack_installation_fk");
    expect(source).toContain("automation_sources_pack_installation_fk");
    expect(source).toContain("pack_connector_id");
    expect(source).toContain("CREATE POLICY session_visibility_isolation ON automation_runs");
    for (const table of tenantTables) {
      expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
    expect(FORCE_RLS_TABLES).not.toContain("automation_webhook_endpoints");
    expect(NON_RLS_RUNTIME_TABLES).toContain("automation_webhook_endpoints");
    expect(RUNTIME_FULL_DML_TABLES).toContain("automation_webhook_endpoints");
  });
});
