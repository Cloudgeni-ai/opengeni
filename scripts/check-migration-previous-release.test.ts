import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("target-schema capabilities and PUBLIC's shared-policy predicates are dependencies", () => {
    const capability = posture.RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.find((routine) =>
      routine.startsWith("create_agent_child_session("),
    )!;
    const predicate = posture.RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES[0]!;
    for (const body of [
      `REVOKE EXECUTE ON FUNCTION public.${capability} FROM opengeni_app;`,
      `DROP FUNCTION public.${capability};`,
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM opengeni_app;",
      `REVOKE EXECUTE ON FUNCTION public.${predicate} FROM PUBLIC;`,
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;",
      `REVOKE EXECUTE ON FUNCTION opengeni_private.${posture.VAULT_RUNTIME_ROUTINES[0]} FROM opengeni_app;`,
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
  });

  test("a grant back restores only what the revoked grantees or a recreate needed", () => {
    const fn = `opengeni_private.${COMPACT_INVENTORY}`;
    for (const body of [
      // Granted back to another role: the runtime still lacks it.
      `REVOKE EXECUTE ON FUNCTION ${fn} FROM opengeni_app;\nGRANT EXECUTE ON FUNCTION ${fn} TO opengeni_migrator;`,
      // Recreated with fewer privileges than the runtime needs.
      "DROP TABLE workspaces;\nCREATE TABLE workspaces (id uuid);\nGRANT SELECT ON workspaces TO opengeni_app;",
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
    expect(
      kinds(
        rolling(
          `REVOKE EXECUTE ON FUNCTION ${fn} FROM opengeni_app;\nGRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC;`,
        ),
      ),
    ).toEqual([]);
  });

  test("reads removals hidden in concatenation, placeholders and helpers it calls", () => {
    for (const body of [
      "DO $$ BEGIN EXECUTE 'REVOKE EXECUTE ON FUNCTION opengeni_private.' || 'list_uncompacted_recording_tracks_v1(integer, text) FROM opengeni_app'; END $$;",
      "DO $$ BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.list_uncompacted_recording_tracks_v1(integer, text) FROM opengeni_app', 'opengeni_private'); END $$;",
      `CREATE FUNCTION pg_temp.withhold() RETURNS void LANGUAGE plpgsql AS $$ BEGIN REVOKE EXECUTE ON FUNCTION opengeni_private.${COMPACT_INVENTORY} FROM opengeni_app; END $$;\nSELECT pg_temp.withhold();`,
    ]) {
      expect({ body, kinds: kinds(rolling(body)) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
    // Only an unconditional top-level CREATE makes an object new to this migration.
    expect(
      kinds(
        rolling(
          "DO $$ BEGIN IF to_regclass('reporting_summary') IS NULL THEN CREATE VIEW reporting_summary AS SELECT 1; END IF; END $$;\nDROP VIEW reporting_summary;",
        ),
      ),
    ).toEqual(["unannotated-removal"]);
    // Session temporary objects are always new.
    expect(kinds(rolling("DROP TABLE IF EXISTS pg_temp.workspaces;"))).toEqual([]);
  });

  test("a release whose posture cannot be read fails the guard", () => {
    for (const name of [
      "RUNTIME_DEFINER_ROUTINES",
      "DEFERRED_RUNTIME_PRIVATE_ROUTINES",
      "RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES",
      "RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES",
      "RUNTIME_TABLE_PRIVILEGES",
    ]) {
      expect(() => previousReleaseContract("release x", { ...posture, [name]: undefined })).toThrow(
        name,
      );
    }
  });

  test("declared private routines may be dropped but never revoked; owner-internal ones are not the runtime's", () => {
    const source = [
      "const OWNER_INTERNAL_PRIVATE_ROUTINES = new Set<string>([",
      "  // a trigger's: the owner's (it's not the runtime's)",
      '  "owner_trigger_v1()",',
      "  ...WIDGET_WORKER_CAPABILITY_ROUTINES,",
      "]);",
      "const WIDGET_WORKER_CAPABILITY_ROUTINES = [",
      '  "claim_widget(text[], integer)", // the owner\'s worker',
      "] as const;",
      "const WIDGET_CAPABILITY_ROUTINES = [",
      '  "count_widgets(uuid)",',
      "] as const;",
    ].join("\n");
    const release = previousReleaseContract(
      "the previous release",
      posture,
      { private: ["legacy_routine_v1(uuid)", "owner_trigger_v1()"], target: [] },
      source,
    );
    expect(release.revokeRequiredRoutines.has("legacy_routine_v1(uuid)")).toBe(true);
    expect(release.revokeRequiredRoutines.has("owner_trigger_v1()")).toBe(false);
    expect(release.requiredRoutines.has("count_widgets(uuid)")).toBe(true);
    expect(release.requiredRoutines.has("claim_widget(text[], integer)")).toBe(false);
    const check = (body: string) => kinds(rolling(body), [release]);
    expect(
      check(
        "REVOKE EXECUTE ON FUNCTION opengeni_private.legacy_routine_v1(uuid) FROM opengeni_app;",
      ),
    ).toEqual(["previous-release-dependency"]);
    // Readiness checks only routines that exist, so a drop is the annotation rule's.
    expect(check("DROP FUNCTION opengeni_private.legacy_routine_v1(uuid);")).toEqual([
      "unannotated-removal",
    ]);
    expect(check("REVOKE EXECUTE ON FUNCTION count_widgets(uuid) FROM opengeni_app;")).toEqual([
      "previous-release-dependency",
    ]);
    expect(
      check("REVOKE EXECUTE ON FUNCTION opengeni_private.owner_trigger_v1() FROM opengeni_app;"),
    ).toEqual(["unannotated-removal"]);
    // An owner-internal list it cannot read in full fails the guard.
    for (const unreadable of [
      "const OTHER_ROUTINES = [];",
      source.replace('"owner_trigger_v1()"', "`owner_${name}()`"),
    ])
      expect(() =>
        previousReleaseContract(
          "release x",
          posture,
          { private: ["legacy_routine_v1(uuid)"] },
          unreadable,
        ),
      ).toThrow("OWNER_INTERNAL_PRIVATE_ROUTINES");
  });

  test("grants back count only for the role that lost the privilege", () => {
    const fn = `opengeni_private.${COMPACT_INVENTORY}`;
    const dynamic = (revokeArgs: string, grantArgs: string) =>
      `DO $$ BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION ${fn} FROM %I', ${revokeArgs}); EXECUTE format('GRANT EXECUTE ON FUNCTION ${fn} TO %I', ${grantArgs}); END $$;`;
    expect(kinds(rolling(dynamic("runtime_role", "runtime_role")))).toEqual([]);
    expect(kinds(rolling(dynamic("runtime_role", "reporting_role")))).toEqual([
      "previous-release-dependency",
    ]);
    // A recreated object is kept only by grants to PUBLIC or the runtime role.
    const recreate = (grantee: string) =>
      `DROP TABLE agent_call_host_phones;\nCREATE TABLE agent_call_host_phones (id uuid);\nGRANT ALL ON agent_call_host_phones TO ${grantee};`;
    expect(kinds(rolling(recreate("opengeni_reporting")))).toEqual(["previous-release-dependency"]);
    expect(kinds(rolling(recreate("opengeni_app")))).toEqual([]);
    // A session temporary routine is always new.
    expect(kinds(rolling(`DROP FUNCTION pg_temp.${COMPACT_INVENTORY};`))).toEqual([]);
  });

  test("a retiring feature's routines may go with the last of its tables", () => {
    const source = [
      "const WIDGET_ROUTINES = [",
      '  "count_widgets(uuid)",',
      "] as const;",
      "const RETIRING_WIDGET_ROUTINES: ReadonlySet<string> = new Set([",
      "  ...WIDGET_ROUTINES,",
      '  "widget_json(uuid)",',
      "]);",
    ].join("\n");
    const release = previousReleaseContract(
      "the previous release",
      {
        ...posture,
        RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES: [
          ...posture.RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
          "count_widgets(uuid)",
          "widget_json(uuid)",
        ],
        RETIRING_FEATURE_TABLES: { widgets: ["widgets", "widget_parts"] },
      },
      null,
      source,
    );
    expect([...release.retiringRoutines.keys()]).toEqual([
      "count_widgets(uuid)",
      "widget_json(uuid)",
    ]);
    const drops = "DROP FUNCTION public.count_widgets(uuid);\nDROP FUNCTION widget_json(uuid);";
    expect(kinds(rolling(`${drops}\nDROP TABLE widgets, widget_parts;`), [release])).toEqual([]);
    // An earlier migration of the same change dropped the other table.
    expect(
      analyzeMigrationPreviousRelease(
        file,
        rolling(`${drops}\nDROP TABLE widgets;`),
        [release],
        GOVERNED,
        new Set(["widget_parts"]),
      ),
    ).toEqual([]);
    for (const body of [
      // Readiness still requires the routines while any table remains.
      `${drops}\nDROP TABLE widgets;`,
      drops,
      // Present without EXECUTE is never tolerated.
      "REVOKE EXECUTE ON FUNCTION count_widgets(uuid) FROM opengeni_app;\nDROP TABLE widgets, widget_parts;",
    ]) {
      expect({ body, kinds: kinds(rolling(body), [release]) }).toEqual({
        body,
        kinds: ["previous-release-dependency"],
      });
    }
  });
});

describe("check-migration-previous-release CLI", () => {
  const CLI = join(ROOT, "scripts/check-migration-previous-release.ts");
  const ROUTINE = "inventory_v1(integer)";

  /** A minimal posture module: the routine is required unless `deferred`. */
  const postureSource = (deferred: boolean) =>
    [
      `export const RUNTIME_DEFINER_ROUTINES = ["${ROUTINE}"];`,
      `export const DEFERRED_RUNTIME_PRIVATE_ROUTINES = ${deferred ? `["${ROUTINE}"]` : "[]"};`,
      "export const RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES = [];",
      "export const RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES = [];",
      'export const RUNTIME_TABLE_PRIVILEGES = { workspaces: ["SELECT"] };',
      "export const RETIRING_FEATURE_TABLES = {};",
      "",
    ].join("\n");

  function repoWithHistory() {
    const root = mkdtempSync(join(tmpdir(), "migration-previous-release-"));
    const run = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8" },
      ).trim();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const commit = (message: string) => {
      run("add", "-A");
      run("commit", "--quiet", "-m", message);
      return run("rev-parse", "HEAD");
    };
    run("init", "--quiet", "--initial-branch=main");
    write("packages/db/drizzle/0001_init.sql", "-- deployment-mode: rolling\nSELECT 1;\n");
    write("packages/db/src/role-relationships.ts", "export {};\n");
    write("packages/db/src/runtime-posture.ts", postureSource(true));
    const pin = commit("pin: defers the routine");
    write(
      "scripts/runtime-posture-baseline.json",
      JSON.stringify({ schemaVersion: 1, status: "production", sourceCommit: pin, release: "img" }),
    );
    write("packages/db/src/runtime-posture.ts", postureSource(false));
    commit("a staging release requires the routine");
    write("packages/db/src/runtime-posture.ts", postureSource(true));
    commit("main defers it again");
    run("checkout", "--quiet", "-b", "change");
    return { root, write, commit };
  }

  const check = (root: string) =>
    spawnSync("bun", [CLI, "--base", "main"], { cwd: root, encoding: "utf8" });

  test("judges added migrations against every posture revision from the pin to the merge base", () => {
    const { root, write, commit } = repoWithHistory();
    try {
      expect(check(root).stdout).toContain("no migration added");
      write(
        "packages/db/drizzle/0002_revoke.sql",
        `-- deployment-mode: rolling\nREVOKE EXECUTE ON FUNCTION opengeni_private.${ROUTINE} FROM opengeni_app;\n`,
      );
      // Untracked files count, so the check works before a commit too.
      const untracked = check(root);
      expect(untracked.status).toBe(1);
      expect(untracked.stderr).toContain("0002_revoke.sql (previous-release-dependency)");
      // Neither the pin nor the merge base requires it; the revision between them does.
      expect(untracked.stderr).toContain(`routine ${ROUTINE}, whose runtime EXECUTE main `);
      commit("revoke");
      expect(check(root).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
