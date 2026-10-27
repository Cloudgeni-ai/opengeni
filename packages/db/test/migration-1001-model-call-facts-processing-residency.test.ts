import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EU_AWS_REGIONS, EU_AZURE_REGIONS, EU_CAPABLE_DEPLOYMENT_TYPES } from "@opengeni/contracts";

// The Insights calls reader patched by 1001 decides in SQL whether a stored
// claim reads as eu, with copies of the contracts lists. Keep them identical,
// so the SQL reader and parseModelCallProcessingResidency always agree (the
// Postgres test checks the agreement row by row).
test("1001's eu rule uses exactly the contracts deployment types and regions", () => {
  const migration = readFileSync(
    new URL("../drizzle/1001_model_call_facts_processing_residency.sql", import.meta.url),
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
});
