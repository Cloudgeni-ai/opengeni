import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL(
  "../drizzle/0321_slack_bot_environment_display_name.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0321-slack-display-name");
});

afterAll(async () => shared?.release());

describe("migration 0321 Slack bot environment display name", () => {
  test("is a rolling constraint-only expansion", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("DROP CONSTRAINT slack_installation_bindings_identity_check");
    expect(source).toContain("bot_display_name IN ('OpenGeni', 'OpenGeni Staging')");
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/iu);
  });

  test("accepts only the production and managed-staging bot names", async () => {
    if (!shared) return;
    const [constraint] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'slack_installation_bindings'::regclass
        and conname = 'slack_installation_bindings_identity_check'`;
    expect(constraint?.definition).toContain(
      "bot_display_name = ANY (ARRAY['OpenGeni'::text, 'OpenGeni Staging'::text])",
    );
  });
});
