import { describe, expect, test } from "bun:test";
import { checkLegacyCodexSource } from "./check-no-legacy-codex-runtime";

describe("M3 PR4 no-legacy runtime guard", () => {
  test("rejects raw SQL, schema access and dynamic table constants", () => {
    for (const code of [
      "const query = sql`select * from codex_capacity_waiters`;",
      "db.select().from(schema.codexSubscriptionCredentials);",
      'const table = "organization_codex_rotation_settings"; sql.identifier(table);',
      "const query = sql`select resolve_workspace_codex_subscription_source($1,$2)`;",
      "const query = sql`select capture_legacy_codex_turn_sources($1,$2)`;",
    ])
      expect(checkLegacyCodexSource("packages/db/src/index.ts", code)).toHaveLength(1);
  });
  test("posture routine signatures cannot authorize decision calls", () => {
    expect(
      checkLegacyCodexSource(
        "packages/db/src/provision-roles.ts",
        'const routines = ["capture_legacy_codex_turn_sources(uuid,uuid)"];',
      ),
    ).toEqual([]);
    expect(
      checkLegacyCodexSource(
        "packages/db/src/provision-roles.ts",
        "const query = sql`select capture_legacy_codex_turn_sources($1,$2)`;",
      ),
    ).toHaveLength(1);
    expect(
      checkLegacyCodexSource(
        "packages/db/src/index.ts",
        'const routines = ["capture_legacy_codex_turn_sources(uuid,uuid)"];',
      ),
    ).toHaveLength(1);
  });
  test("exceptions authorize only exact declarations, not other queries in their files", () => {
    expect(
      checkLegacyCodexSource(
        "packages/db/src/runtime-posture.ts",
        'export const FORCE_RLS_TABLES = ["codex_capacity_waiters"];',
      ),
    ).toEqual([]);
    expect(
      checkLegacyCodexSource(
        "packages/db/src/runtime-posture.ts",
        "function read() { return sql`select * from codex_capacity_waiters`; }",
      ),
    ).toHaveLength(1);
    expect(
      checkLegacyCodexSource(
        "packages/db/src/codex-subscription-core-cutover.ts",
        "function fallback() { return sql`select * from codex_subscription_credentials`; }",
      ),
    ).toHaveLength(1);
  });
  test("blocks production imports of historical fixtures and deleted producers", () => {
    for (const code of [
      'import { peekSessionWork } from "../test/fixtures/legacy-codex";',
      'export * from "@opengeni/db/test/fixtures/legacy-codex";',
      'const fixture = await import("../../test/fixtures/legacy-codex");',
      'const retired = require("./codex-rotation");',
    ])
      expect(checkLegacyCodexSource("apps/worker/src/run.ts", code)).toHaveLength(1);
  });
  test("retains ledger, aliases, Temporal names and historical event decoding", () => {
    expect(
      checkLegacyCodexSource(
        "packages/db/src/index.ts",
        `
      // codex_capacity_waiters is retired, not an executable query.
      const row = schema.codexResetRedemptionAttempts;
      const event = "codex.fleet.decision";
      const activity = "getCodexCapacityWait";
      const signal = "codexCapacityChanged";
    `,
      ),
    ).toEqual([]);
  });
});
