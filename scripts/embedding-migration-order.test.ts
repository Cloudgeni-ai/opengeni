import { expect, test } from "bun:test";
import { buildSchemaContract } from "./release-schema-contract";

test("embedding migrations append after main's published 0430 without duplicate ordinals", async () => {
  const contract = await buildSchemaContract();
  const tail = contract.migrations.filter((m) => Number(m.path.slice(0, 4)) >= 431);
  expect(tail).toHaveLength(21);
  expect(tail.map((m) => Number(m.path.slice(0, 4)))).toEqual(
    Array.from({ length: 21 }, (_, i) => 431 + i),
  );
  expect(contract.latestMigration).toBe("0451_canonical_session_scope_subject.sql");
  // Historical main contains repeated ordinals; do not rewrite published history.
  const ordinals = tail.map((m) => m.path.slice(0, 4));
  expect(new Set(ordinals).size).toBe(ordinals.length);
  expect(tail.every((m) => ["rolling", "maintenance"].includes(m.deploymentMode))).toBe(true);
  expect(contract.migrations.find((m) => m.path.startsWith("0425_"))?.path).toBe(
    "0425_feedback_submissions.sql",
  );
});
