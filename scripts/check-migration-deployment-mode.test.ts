import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOVERNED_FROM_ORDINAL,
  MIGRATIONS_DIR,
  analyzeMigrationDeploymentMode,
  analyzeMigrationDeploymentModes,
  contractOperations,
  headerValue,
  migrationOrdinal,
  placeholderReason,
} from "./migration-deployment-mode";

const GOVERNED = 5000;
const JUSTIFICATION =
  "-- maintenance-justification: the new trigger rejects every write from pre-5000 workers, and a dual-protocol window would let both fence orders deadlock.";

const directories: string[] = [];

function ledger(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "migration-deployment-mode-"));
  directories.push(directory);
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(directory, file), sql);
  return directory;
}

function kinds(file: string, sql: string): string[] {
  return analyzeMigrationDeploymentMode(file, sql, GOVERNED).map((finding) => finding.kind);
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("migration deployment-mode guard", () => {
  test("a rolling expand migration passes", () => {
    const directory = ledger({
      "5000_widget_color.sql":
        "-- deployment-mode: rolling\nALTER TABLE widgets ADD COLUMN color text;\nCREATE INDEX widgets_color ON widgets (color);\n",
    });
    expect(analyzeMigrationDeploymentModes(directory, GOVERNED)).toEqual([]);
  });

  test("a maintenance migration needs a justification", () => {
    const directory = ledger({
      "5000_cutover.sql":
        "-- deployment-mode: maintenance\n-- Swap the fence protocol.\nSELECT 1;\n",
      "5001_justified.sql": `-- deployment-mode: maintenance\n-- Swap the fence protocol.\n${JUSTIFICATION}\nSELECT 1;\n`,
    });
    const findings = analyzeMigrationDeploymentModes(directory, GOVERNED);
    expect(findings.map((finding) => [finding.file, finding.kind])).toEqual([
      ["5000_cutover.sql", "missing-justification"],
    ]);
    expect(findings[0]!.detail).toContain("-- maintenance-justification:");
  });

  test("a justification may wrap across continuation comment lines", () => {
    const sql = [
      "-- deployment-mode: maintenance",
      "-- opengeni:batched-backfill size=500 lock_timeout=5s statement_timeout=60s",
      "-- maintenance-justification: installs triggers that reject pre-5000",
      "--   writers outright, so old and new binaries cannot share the schema.",
      "--",
      "-- Other notes that are not part of the justification.",
      "SELECT 1;",
    ].join("\n");
    expect(kinds("5000_wrapped.sql", sql)).toEqual([]);
    expect(headerValue(sql, "maintenance-justification")?.full).toBe(
      "installs triggers that reject pre-5000 writers outright, so old and new binaries cannot share the schema.",
    );
  });

  test("placeholder and too-short justifications are rejected", () => {
    for (const value of ["TODO", "TODO: explain why", "TBD", "n/a", "N/A.", "none", "", "<why>"]) {
      const sql = `-- deployment-mode: maintenance\n-- maintenance-justification: ${value}\nSELECT 1;\n`;
      expect(kinds("5000_placeholder.sql", sql)).toEqual(["weak-justification"]);
    }
    expect(
      kinds(
        "5000_short.sql",
        "-- deployment-mode: maintenance\n-- maintenance-justification: too risky\nSELECT 1;\n",
      ),
    ).toEqual(["weak-justification"]);
    // Copying the template from the error output verbatim is still a placeholder.
    expect(
      kinds(
        "5000_template.sql",
        "-- deployment-mode: maintenance\n-- maintenance-justification: <why old and new binaries cannot share this schema,\n--   and why no expand/contract sequence avoids draining the fleet>\nSELECT 1;\n",
      ),
    ).toEqual(["weak-justification"]);
    // A real sentence that happens to start with a placeholder-like word is fine.
    expect(
      placeholderReason("none of the expand/contract sequences keep old writers correct"),
    ).toBeNull();
  });

  test("the justification must be in the leading comment block", () => {
    const sql = `-- deployment-mode: maintenance\nSELECT 1;\n${JUSTIFICATION}\nSELECT 2;\n`;
    expect(kinds("5000_late.sql", sql)).toEqual(["missing-justification"]);
  });

  test("grandfathered migrations are exempt", () => {
    const directory = ledger({
      "4999_shipped_maintenance.sql": "-- deployment-mode: maintenance\nSELECT 1;\n",
      "4998_shipped_rolling_drop.sql":
        "-- deployment-mode: rolling\nALTER TABLE widgets DROP COLUMN color;\n",
      "0010_historical.sql": "CREATE TABLE widgets (id uuid);\n",
    });
    expect(analyzeMigrationDeploymentModes(directory, GOVERNED)).toEqual([]);
  });

  test("line 1 must be an exact deployment-mode header", () => {
    for (const sql of [
      "ALTER TABLE widgets ADD COLUMN color text;\n",
      "-- Adds color.\n-- deployment-mode: rolling\nSELECT 1;\n",
      "-- deployment-mode: online\nSELECT 1;\n",
      "-- deployment-mode:rolling\nSELECT 1;\n",
      "",
    ]) {
      expect(kinds("5000_unclassified.sql", sql)).toEqual(["missing-header"]);
    }
    expect(kinds("5000_crlf.sql", "-- deployment-mode: rolling\r\nSELECT 1;\r\n")).toEqual([]);
    const [finding] = analyzeMigrationDeploymentMode("5000_x.sql", "SELECT 1;\n", GOVERNED);
    expect(finding!.detail).toContain("`-- deployment-mode: rolling` (the default)");
  });

  test("rolling contract-phase DDL needs a contract-step annotation", () => {
    const cases: [string, string][] = [
      ["ALTER TABLE widgets DROP COLUMN legacy_color;", "DROP COLUMN"],
      ["ALTER TABLE IF EXISTS public.widgets DROP COLUMN IF EXISTS legacy_color;", "DROP COLUMN"],
      ["DROP TABLE legacy_widgets;", "DROP TABLE"],
      ["DROP TABLE IF EXISTS legacy_widgets, other_widgets CASCADE;", "DROP TABLE"],
      ["ALTER TABLE widgets RENAME COLUMN color TO colour;", "RENAME COLUMN"],
      ['ALTER TABLE "widgets" RENAME "color" TO "colour";', "RENAME COLUMN"],
      ["ALTER TABLE widgets RENAME TO gadgets;", "RENAME TABLE"],
      ["ALTER TABLE widgets ALTER COLUMN size TYPE bigint;", "ALTER COLUMN ... TYPE"],
      ["ALTER TABLE widgets ALTER size SET DATA TYPE bigint;", "ALTER COLUMN ... TYPE"],
      ['ALTER TABLE ONLY widgets ALTER COLUMN "owner" SET NOT NULL;', "SET NOT NULL"],
      [
        "DO $$ BEGIN IF true THEN ALTER TABLE widgets DROP COLUMN legacy_color; END IF; END $$;",
        "DROP COLUMN",
      ],
    ];
    for (const [statement, label] of cases) {
      const sql = `-- deployment-mode: rolling\n${statement}\n`;
      expect(contractOperations(sql)).toEqual([label]);
      expect(kinds("5000_contract.sql", sql)).toEqual(["unannotated-contract"]);
      expect(
        kinds(
          "5000_contract.sql",
          `-- deployment-mode: rolling\n-- contract-step: release 2026.10.20 (migration 4990) stopped reading it\n${statement}\n`,
        ),
      ).toEqual([]);
    }
  });

  test("placeholder or too-short contract-step annotations are rejected", () => {
    for (const value of ["TODO", "tbd", "n/a", "later", "4990"]) {
      const sql = `-- deployment-mode: rolling\n-- contract-step: ${value}\nALTER TABLE widgets DROP COLUMN legacy_color;\n`;
      expect(kinds("5000_contract.sql", sql)).toEqual(["weak-contract-step"]);
    }
  });

  test("non-contract drops and renames are not flagged", () => {
    const sql = `-- deployment-mode: rolling
DROP INDEX IF EXISTS widgets_color;
DROP INDEX CONCURRENTLY IF EXISTS widgets_size;
DROP TRIGGER IF EXISTS widgets_touch ON widgets;
DROP POLICY IF EXISTS widgets_read ON widgets;
DROP FUNCTION IF EXISTS opengeni_private.widgets_touch();
DROP VIEW IF EXISTS widget_summary;
ALTER TABLE widgets DROP CONSTRAINT IF EXISTS widgets_color_check;
ALTER TABLE widgets RENAME CONSTRAINT widgets_a TO widgets_b;
ALTER TABLE widgets ALTER COLUMN color DROP NOT NULL;
ALTER TABLE widgets ALTER COLUMN color SET DEFAULT 'red';
ALTER TABLE widgets ADD COLUMN size bigint NOT NULL DEFAULT 0;
ALTER INDEX widgets_size RENAME TO widgets_size_idx;
ALTER TYPE widget_kind ADD VALUE IF NOT EXISTS 'round';
DO $$ BEGIN ALTER TABLE widgets ADD COLUMN shade text; ALTER INDEX widgets_x RENAME TO widgets_y; END $$;
`;
    expect(contractOperations(sql)).toEqual([]);
  });

  test("tables created by the same migration may be reshaped and dropped", () => {
    const sql = `-- deployment-mode: rolling
CREATE TEMP TABLE widget_backfill AS SELECT id FROM widgets;
CREATE TABLE IF NOT EXISTS public.gadgets (id uuid, size int);
ALTER TABLE gadgets ALTER COLUMN size TYPE bigint;
ALTER TABLE gadgets ALTER COLUMN size SET NOT NULL;
ALTER TABLE gadgets RENAME COLUMN size TO weight;
DROP TABLE widget_backfill;
DROP TABLE IF EXISTS "widget_backfill";
`;
    expect(contractOperations(sql)).toEqual([]);
    expect(contractOperations(`${sql}DROP TABLE widget_backfill, widgets;\n`)).toEqual([
      "DROP TABLE",
    ]);
  });

  test("comments, string literals and routine bodies are not executable DDL", () => {
    const sql = `-- deployment-mode: rolling
-- Later we will ALTER TABLE widgets DROP COLUMN legacy_color;
/* ALTER TABLE widgets RENAME TO gadgets; */
ALTER TABLE widgets ADD COLUMN note text DEFAULT 'ALTER TABLE x DROP COLUMN y'; -- DROP TABLE widgets;
COMMENT ON COLUMN widgets.note IS 'replaces DROP TABLE legacy_widgets';
CREATE OR REPLACE FUNCTION opengeni_private.cleanup() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
  DROP TABLE legacy_widgets;
  ALTER TABLE widgets DROP COLUMN legacy_color;
END
$body$;
`;
    expect(contractOperations(sql)).toEqual([]);
    expect(kinds("5000_comments.sql", sql)).toEqual([]);
  });

  test("migration ordinals parse only NNNN_*.sql names", () => {
    expect(migrationOrdinal("0786_widgets.sql")).toBe(786);
    expect(migrationOrdinal("README.md")).toBeNull();
    expect(migrationOrdinal("meta")).toBeNull();
  });

  test("the shipped ledger passes and the threshold is above every grandfathered file", () => {
    expect(analyzeMigrationDeploymentModes(MIGRATIONS_DIR)).toEqual([]);
    expect(GOVERNED_FROM_ORDINAL).toBe(786);
  });
});
