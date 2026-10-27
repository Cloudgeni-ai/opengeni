import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EU_AWS_REGIONS,
  EU_AZURE_REGIONS,
  EU_CAPABLE_DEPLOYMENT_TYPES,
  MODEL_DEPLOYMENT_TYPES,
  MODEL_PROCESSING_GEOGRAPHIES,
} from "@opengeni/contracts";

// The Insights calls reader patched by 1003 decides in SQL whether a stored
// claim reads as eu, with copies of the contracts lists. Keep them identical,
// so the SQL reader and parseModelCallProcessingResidency always agree (the
// Postgres test checks the agreement row by row).
test("1003's eu rule uses exactly the contracts deployment types and regions", () => {
  const migration = readFileSync(
    new URL("../drizzle/1003_model_call_facts_processing_residency.sql", import.meta.url),
    "utf8",
  );
  const regionless = EU_CAPABLE_DEPLOYMENT_TYPES.filter(
    (type) => !type.startsWith("azure_") && !type.startsWith("bedrock_"),
  );
  const regional = EU_CAPABLE_DEPLOYMENT_TYPES.filter((type) => !regionless.includes(type));
  expect(regional).toEqual([
    "azure_regional",
    "azure_data_zone",
    "bedrock_regional",
    "bedrock_geo_profile",
  ]);
  const names = (values: readonly string[]) => values.map((value) => `'${value}'`).join(",");
  const jsonStrings = (values: readonly string[]) =>
    values.map((value) => `'"${value}"'`).join(",");
  expect(migration).toContain(`IN(${names(regionless)}) THEN 'eu'`);
  expect(migration).toContain(`NOT IN(${names(regional)}) THEN 'unknown'`);
  expect(migration).toContain(`NOT IN(${jsonStrings(EU_AZURE_REGIONS)})`);
  expect(migration).toContain(`NOT IN(${jsonStrings(EU_AWS_REGIONS)})`);
  // Well-formedness, checked before any geography is returned: the listed
  // geographies and deployment types, and at most 32 region-shaped strings
  // (the contracts REGION_PATTERN and max).
  expect(migration).toContain(
    `COALESCE(f.processing_residency->>'geography','') NOT IN(${names(MODEL_PROCESSING_GEOGRAPHIES)}) THEN 'unknown'`,
  );
  expect(migration).toContain(
    `COALESCE(f.processing_residency->>'deploymentType','') NOT IN(${names(MODEL_DEPLOYMENT_TYPES)}) THEN 'unknown'`,
  );
  expect(migration).toContain(`jsonb_array_length(f.processing_residency->'regions')>32`);
  expect(migration).toContain(`!~ '^[a-z0-9][a-z0-9-]{0,62}$'`);
  // Every structural check precedes the first branch that can return a
  // stored geography or eu.
  const firstReturn = migration.indexOf(
    "WHEN f.processing_residency->>'geography'<>'eu' THEN f.processing_residency->>'geography'",
  );
  expect(firstReturn).toBeGreaterThan(migration.indexOf("!~ '^[a-z0-9]"));
  expect(firstReturn).toBeLessThan(
    migration.indexOf("IN('provider_default','self_hosted') THEN 'eu'"),
  );
});
