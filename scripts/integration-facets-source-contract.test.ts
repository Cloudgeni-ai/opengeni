import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const productionRoots = [
  "apps/api/src",
  "apps/web/src",
  "apps/worker/src",
  "packages/capabilities/src",
  "packages/contracts/src",
  "packages/core/src",
  "packages/db/src",
  "packages/sdk/src",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("Integration Facets are the only production sub-capability authority", () => {
  for (const removedFile of [
    "apps/api/src/routes/integration-features.ts",
    "apps/web/src/components/capabilities/integration-features-panel.tsx",
    "packages/db/src/integration-features.ts",
  ]) {
    expect(existsSync(join(repositoryRoot, removedFile))).toBe(false);
  }

  const forbiddenIdentities = [
    /\bIntegrationFeature[A-Za-z]*\b/,
    /\bintegrationFeature[A-Za-z]*\b/,
    /\b[A-Za-z0-9]*IntegrationFeature[A-Za-z0-9]*\b/,
    /\b[A-Za-z0-9]*integrationFeature[A-Za-z0-9]*\b/,
    /\bfeatureKey\b/,
    /\bintegration_feature_(?:facets|bindings|binding_owners)\b/,
    /\/integrations\/[^"'`\s]+\/instances\/[^"'`\s]+\/features\b/,
    /kind:\s*["']feature["']/,
    /z\.literal\(["']feature["']\)/,
    /\b(?:list|configure|pause|resume|remove)IntegrationFeature\b/,
  ];
  const violations: string[] = [];

  for (const root of productionRoots) {
    for (const file of sourceFiles(join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenIdentities) {
        if (forbidden.test(source)) {
          violations.push(`${relative(repositoryRoot, file)}: ${forbidden.source}`);
        }
      }
    }
  }

  expect(violations).toEqual([]);

  const contracts = readFileSync(join(repositoryRoot, "packages/contracts/src/index.ts"), "utf8");
  const schema = readFileSync(join(repositoryRoot, "packages/db/src/schema.ts"), "utf8");
  const routes = readFileSync(
    join(repositoryRoot, "apps/api/src/routes/integration-facets.ts"),
    "utf8",
  );

  expect(contracts).toContain("IntegrationInstanceFacetsResponse");
  expect(contracts).toContain('kind: z.literal("facet")');
  expect(schema).toContain('"integration_facet_definitions"');
  expect(schema).toContain('"integration_facet_bindings"');
  expect(schema).toContain('"integration_facet_binding_owners"');
  expect(routes).toContain("/facets/:facetKey");
});
