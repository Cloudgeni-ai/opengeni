import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS } from "@opengeni/contracts";

function migration(name: string) {
  return readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
}

test("instruction size migration changes only the private helper's existing length checks", () => {
  const previous = migration("0462_agent_instruction_non_destructive_edits.sql");
  const next = migration("0584_agent_instruction_size_parity.sql");
  const definition = (source: string) =>
    source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION"),
      source.indexOf("END $$;") + "END $$;".length,
    );
  expect(next).toStartWith("-- deployment-mode: rolling\n");
  expect(definition(next)).toBe(
    definition(previous)
      .replace("FUNCTION agent_instruction_apply(", "FUNCTION agent_instruction_apply_0462_unsafe(")
      .replaceAll("600", String(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)),
  );
  expect(next).toContain("SET search_path = %I, pg_catalog, pg_temp");
  expect(next).not.toMatch(/GRANT|DROP|ALTER TABLE|CREATE TRIGGER/u);
});
