import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as posture from "../packages/db/src/runtime-posture";
import {
  REMOVAL_GOVERNED_FROM_ORDINAL,
  analyzeMigrationPreviousRelease,
  migrationRemovals,
  normalizeRoutineSignature,
  previousReleaseContract,
} from "./migration-previous-release";

const COMPACT_INVENTORY = "list_uncompacted_recording_tracks_v1(integer, text)";
const MIGRATION_1283 = "1283_withhold_recording_compact_inventory.sql";
const ROOT = join(import.meta.dir, "..");

/** The declarations of a release, from the real posture module with its deferrals overridden. */
function releaseDeclaring(deferred: readonly string[]) {
  return previousReleaseContract("the previous release", {
    ...posture,
    DEFERRED_RUNTIME_PRIVATE_ROUTINES: deferred,
  });
}

/** The release that served while 1283 ran: 1282 had granted the inventory and required it. */
const requiresInventory = releaseDeclaring(
  posture.DEFERRED_RUNTIME_PRIVATE_ROUTINES.filter((routine) => routine !== COMPACT_INVENTORY),
);
/** A release that accepts the inventory with or without EXECUTE. */
const defersInventory = releaseDeclaring([
  ...new Set([...posture.DEFERRED_RUNTIME_PRIVATE_ROUTINES, COMPACT_INVENTORY]),
]);

const GOVERNED = REMOVAL_GOVERNED_FROM_ORDINAL + 1000;
const file = `${GOVERNED}_example.sql`;

function kinds(sql: string, contracts = [requiresInventory], name = file): string[] {
  return analyzeMigrationPreviousRelease(name, sql, contracts, GOVERNED).map(
    (finding) => finding.kind,
  );
}

const rolling = (body: string, header = "") =>
  `-- deployment-mode: rolling\n${header}SET LOCAL lock_timeout = '5s';\n${body}\n`;

describe("migration previous-release guard", () => {
  test("rejects 1283: a rolling REVOKE of a definer the serving release requires", () => {
    const sql = readFileSync(join(ROOT, "packages/db/drizzle", MIGRATION_1283), "utf8");
    const findings = analyzeMigrationPreviousRelease(MIGRATION_1283, sql, [requiresInventory]);
    expect(findings.map((finding) => finding.kind)).toEqual(["previous-release-dependency"]);
    expect(findings[0]!.detail).toContain(`routine ${COMPACT_INVENTORY}`);
    expect(findings[0]!.detail).toContain("the previous release requires");
    // The same migration is fine once the serving release has deferred the routine.
    expect(analyzeMigrationPreviousRelease(MIGRATION_1283, sql, [defersInventory])).toEqual([]);
    // Any release still serving counts: the main merge base or the pinned baseline.
    expect(
      analyzeMigrationPreviousRelease(MIGRATION_1283, sql, [defersInventory, requiresInventory]),
    ).toHaveLength(1);
  });

  test("a contract-step annotation does not clear a declared dependency; maintenance does", () => {
    const revoke = `REVOKE EXECUTE ON FUNCTION opengeni_private.${COMPACT_INVENTORY} FROM opengeni_app;`;
    expect(
      kinds(rolling(revoke, "-- contract-step: 1282 granted it and nothing needs it now\n")),
    ).toEqual(["previous-release-dependency"]);
    expect(kinds(`-- deployment-mode: maintenance\n${revoke}`)).toEqual([]);
  });

  test("reads static, DO-block and EXECUTE-string SQL and normalizes signatures", () => {
    for (const body of [
      "REVOKE ALL ON FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(p_limit int, p_after TEXT) FROM PUBLIC, opengeni_app;",
      'REVOKE EXECUTE ON ROUTINE "opengeni_private"."list_uncompacted_recording_tracks_v1"(integer, text) FROM opengeni_app;',
      "REVOKE EXECUTE ON FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1 FROM opengeni_app;",
      "DO $$ BEGIN REVOKE EXECUTE ON FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(integer, text) FROM opengeni_app; END $$;",
      "DO $x$ BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(integer, text) FROM %I', 'opengeni_app'); END $x$;",
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private FROM opengeni_app;",
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
    expect(normalizeRoutineSignature("s.f(IN a int4, OUT b text, VARIADIC c varchar(20)[])")).toBe(
      "f(integer, character varying[])",
    );
    expect(normalizeRoutineSignature("f(at timestamptz, d double precision DEFAULT 1)")).toBe(
      "f(timestamp with time zone, double precision)",
    );
  });

  test("removals the migration undoes before it commits are not removals", () => {
    const fn = `opengeni_private.${COMPACT_INVENTORY}`;
    expect(
      kinds(
        rolling(
          `REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, opengeni_app;\nGRANT EXECUTE ON FUNCTION ${fn} TO opengeni_app;`,
        ),
      ),
    ).toEqual([]);
    // Granting back something else does not restore EXECUTE.
    expect(
      kinds(
        rolling(
          `REVOKE ALL ON TABLE workspaces FROM opengeni_app;\nGRANT SELECT ON TABLE workspaces TO opengeni_app;`,
        ),
      ),
    ).toEqual(["previous-release-dependency"]);
    expect(
      kinds(
        rolling(
          `DROP FUNCTION ${fn};\nCREATE FUNCTION ${fn.replace("(integer, text)", "(p_limit integer, p_after text)")} RETURNS void LANGUAGE sql AS $$ SELECT $$;\nGRANT EXECUTE ON FUNCTION ${fn} TO opengeni_app;`,
        ),
      ),
    ).toEqual([]);
    // Recreated without the grant the previous release requires.
    expect(
      kinds(
        rolling(
          `DROP FUNCTION ${fn};\nCREATE FUNCTION ${fn} RETURNS void LANGUAGE sql AS $$ SELECT $$;`,
        ),
      ),
    ).toEqual(["previous-release-dependency"]);
    // A routine this migration creates is new; hardening it is fine.
    expect(
      kinds(
        rolling(
          "CREATE FUNCTION opengeni_private.brand_new_v1(integer) RETURNS void LANGUAGE sql AS $$ SELECT $$;\nREVOKE ALL ON FUNCTION opengeni_private.brand_new_v1(integer) FROM PUBLIC;",
        ),
      ),
    ).toEqual([]);
  });

  test("drops, renames and revokes of declared tables, routines and schemas", () => {
    const fn = `opengeni_private.${COMPACT_INVENTORY}`;
    for (const body of [
      `DROP FUNCTION IF EXISTS ${fn} CASCADE;`,
      `ALTER FUNCTION ${fn} RENAME TO list_uncompacted_recording_tracks_v0;`,
      `ALTER FUNCTION ${fn} SET SCHEMA public;`,
      "REVOKE INSERT, UPDATE ON public.workspaces FROM opengeni_app;",
      "ALTER TABLE IF EXISTS workspaces RENAME TO workspaces_old;",
      "DROP TABLE workspaces;",
      "REVOKE USAGE ON SCHEMA opengeni_private FROM opengeni_app;",
      // The runtime may hold USAGE on public only through PUBLIC.
      "REVOKE USAGE ON SCHEMA public FROM PUBLIC;",
      "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM opengeni_app;",
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
    for (const body of [
      // Privileges the runtime never had are not a dependency.
      "REVOKE TRUNCATE ON workspaces FROM opengeni_app;",
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
      "REVOKE GRANT OPTION FOR SELECT ON workspaces FROM opengeni_app;",
      // Readiness lets a retiring feature's tables be absent.
      `DROP TABLE IF EXISTS ${Object.values(posture.RETIRING_FEATURE_TABLES).flat()[0]};`,
      // Definers and tables are never PUBLIC's; revoking that enforces the posture.
      `REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`,
      "REVOKE ALL ON workspaces FROM PUBLIC CASCADE;",
      // Only future objects.
      "ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
      // Routines the previous release defers or does not know.
      "REVOKE EXECUTE ON FUNCTION opengeni_private.not_a_runtime_routine_v1(uuid) FROM opengeni_app;",
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({ body, kinds: [] });
    }
  });

  test("other removals of existing objects need a contract-step annotation", () => {
    for (const body of [
      "DROP VIEW reporting_summary;",
      "DROP MATERIALIZED VIEW IF EXISTS reporting_rollup;",
      "DROP FUNCTION public.legacy_helper(uuid);",
      "ALTER TYPE widget_state RENAME VALUE 'old' TO 'new';",
      "DROP TYPE widget_state;",
      "ALTER VIEW reporting_summary RENAME TO reporting_overview;",
      "DO $$ BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM opengeni_app', 'x'); END $$;",
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["unannotated-removal"],
      });
      expect(
        kinds(rolling(body, "-- contract-step: the 6.10 release stopped reading it (#1234)\n")),
      ).toEqual([]);
      expect(kinds(rolling(body, "-- contract-step: TODO\n"))).toEqual(["unannotated-removal"]);
      // Shipped migrations below the floor are immutable and not re-judged.
      expect(kinds(rolling(body), [requiresInventory], `${GOVERNED - 1}_example.sql`)).toEqual([]);
    }
    // Created in the same migration, so nothing older uses it.
    expect(
      kinds(rolling("CREATE VIEW scratch_view AS SELECT 1;\nDROP VIEW scratch_view;")),
    ).toEqual([]);
    // A revoke on a routine the release knows but does not require.
    const known = releaseDeclaring(posture.DEFERRED_RUNTIME_PRIVATE_ROUTINES);
    expect(
      kinds(
        rolling(
          `REVOKE EXECUTE ON FUNCTION opengeni_private.${posture.DEFERRED_RUNTIME_PRIVATE_ROUTINES[0]} FROM opengeni_app;`,
        ),
        [known],
      ),
    ).toEqual(["unannotated-removal"]);
  });

  test("lists removals in file order with what they break", () => {
    const removals = migrationRemovals(
      rolling(
        `REVOKE EXECUTE ON FUNCTION opengeni_private.${COMPACT_INVENTORY} FROM opengeni_app;\nDROP VIEW old_view;`,
      ),
      [requiresInventory],
    );
    expect(
      removals.map((removal) => [removal.dependencies.length, removal.annotationReason]),
    ).toEqual([
      [1, null],
      [0, "drops view old_view"],
    ]);
  });
});
