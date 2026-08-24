import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL(
  "../drizzle/0328_slack_orchestration_delivery_events.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0328-slack-orchestration-delivery-events");
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0328 Slack orchestration delivery events", () => {
  test("is a rolling definer replacement with a re-pinned search_path and no backfill", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_delivery",
    );
    // A CREATE OR REPLACE drops the previous per-function settings, so the
    // definer search_path must be re-pinned in the same statement.
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.claim_slack_interaction_delivery(uuid, integer)",
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION opengeni_private\.claim_slack_interaction_delivery/u,
    );
    expect(sql).not.toMatch(/\bUPDATE\s+"?slack_interactions/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/iu);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/iu);
  });

  test("arms delivery for the orchestration event types while keeping the pre-existing set", async () => {
    if (!shared) return;
    const [routine] = await shared.admin<Array<{ definition: string; config: string[] | null }>>`
      select pg_get_functiondef(p.oid) as definition, p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname = 'claim_slack_interaction_delivery'`;
    const definition = routine?.definition.replace(/\s+/gu, " ") ?? "";
    for (const type of [
      "agent.message.completed",
      "session.humanInput.requested",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "session.status.changed",
      "system.update.pending",
      "goal.paused",
    ]) {
      expect(definition).toContain(`'${type}'`);
    }
    // The claim only decides eligibility; nothing else about it moved.
    expect(definition).toContain("FOR UPDATE SKIP LOCKED");
    expect(definition).toContain("SECURITY DEFINER");
    expect(routine?.config).toContain("search_path=pg_catalog");
  });
});
