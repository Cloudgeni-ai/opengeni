import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0386_continuability_projection_performance.sql",
  import.meta.url,
);

describe("0386 continuability projection performance migration", () => {
  test("is a rolling, result-compatible indexed classification repair", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.list_continuable_sessions(",
    );
    expect(source).toContain("classified AS MATERIALIZED");
    expect(source.match(/CASE WHEN(?: NOT session\.blocked AND)? EXISTS \(/gu)).toHaveLength(7);
    expect(source).not.toContain("queued_human AS (");
    expect(source).not.toContain("LEFT JOIN queued_human");

    const reasonOrder = [
      "interruption_settlement",
      "queued_human",
      "recovering_turn",
      "capacity_wait",
      "decided_approval",
      "active_goal",
      "pending_internal_updates",
      "compaction_requested",
    ];
    let previousIndex = -1;
    for (const reason of reasonOrder) {
      const index = source.indexOf(`'${reason}'`);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
