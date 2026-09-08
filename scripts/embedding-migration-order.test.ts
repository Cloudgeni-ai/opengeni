import { expect, test } from "bun:test";
import { buildSchemaContract } from "./release-schema-contract";

test("embedding migrations append after main's published 0424 without duplicate ordinals", async () => {
  const contract = await buildSchemaContract();
  const tail = contract.migrations.filter((m) => Number(m.path.slice(0, 4)) >= 425);
  expect(tail).toHaveLength(20);
  expect(tail.map((m) => Number(m.path.slice(0, 4)))).toEqual(
    Array.from({ length: 20 }, (_, i) => 425 + i),
  );
  expect(contract.latestMigration).toBe("0445_social_connection_versions.sql");
  // Historical main contains repeated ordinals; do not rewrite published history.
  const ordinals = tail.map((m) => m.path.slice(0, 4));
  expect(new Set(ordinals).size).toBe(ordinals.length);
  expect(tail.every((m) => ["rolling", "maintenance"].includes(m.deploymentMode))).toBe(true);
  expect(contract.migrations.find((m) => m.path.startsWith("0424_"))?.path).toBe(
    "0424_model_connection_access.sql",
  );
});
