import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const realtimeMigration = new URL("../drizzle/0238_supergrok_realtime_model.sql", import.meta.url);
const videoMigration = new URL("../drizzle/0239_supergrok_video_funding.sql", import.meta.url);

describe("migrations 0238/0239 SuperGrok media", () => {
  test("are rolling and admit only the explicit realtime model and funding state", async () => {
    const [realtime, video] = await Promise.all([
      readFile(realtimeMigration, "utf8"),
      readFile(videoMigration, "utf8"),
    ]);
    expect(realtime.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(video.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(realtime).toContain("supergrok/grok-voice-think-fast-2.0");
    expect(video).toContain("'supergrok_subscription'");
    expect(video).toContain('"connection_id" IS NULL');
    expect(video).toContain('"priced_cost_micros" = 0');
    expect(video).toContain("\"credit_state\" = 'not_applicable'");
    expect(`${realtime}\n${video}`).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);

    const blank = await acquireBlankTestDatabase("migration-0238-0239-supergrok-media");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await migrate(blank.databaseUrl);
      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'session_realtime_modes_model_check',
          'workspace_video_generation_policies_funding_source_chk',
          'video_generation_operations_funding_state_chk',
          'video_generation_operations_funding_values_chk'
        )
        order by conname`;
      expect(constraints).toHaveLength(4);
      expect(constraints.map((row) => row.definition).join("\n")).toContain(
        "supergrok_subscription",
      );
      expect(constraints.map((row) => row.definition).join("\n")).toContain(
        "supergrok/grok-voice-think-fast-2.0",
      );
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
