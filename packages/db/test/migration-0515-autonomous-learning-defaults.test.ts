import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_AGENT_LEARNING } from "@opengeni/contracts";

const migration = readFileSync(
  new URL("../drizzle/0515_autonomous_learning_defaults.sql", import.meta.url),
  "utf8",
);
const original = readFileSync(
  new URL("../drizzle/0461_unified_knowledge.sql", import.meta.url),
  "utf8",
);

test("SQL fallback replacements agree with contracts and do not rewrite saved policy", () => {
  const oldDefaults = migration.match(/old_defaults text := '([^']+)'/)![1]!;
  const newDefaults = migration.match(/new_defaults text := '([^']+)'/)![1]!;
  expect(JSON.parse(newDefaults)).toEqual(DEFAULT_AGENT_LEARNING);
  for (const name of ["knowledge_learning_resolve", "agent_learning_manage"]) {
    const body = original.slice(original.indexOf(`CREATE FUNCTION ${name}(`)).split("END $$;")[0]!;
    expect(body.split(oldDefaults)).toHaveLength(2);
    expect(body.replace(oldDefaults, newDefaults).replace(newDefaults, oldDefaults)).toBe(body);
  }
  expect(migration).toContain(
    "RAISE EXCEPTION 'autonomous learning defaults source contract changed",
  );
  expect(migration).toContain("cutover timestamptz := clock_timestamp()");
  expect(migration).toContain("CASE WHEN p_at < %L::timestamptz THEN %L::jsonb ELSE %L::jsonb END");
  expect(migration).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER TABLE|GRANT|REVOKE)\b/);
});
