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

test("Integration Definitions are the only production identity for API integrations", () => {
  expect(existsSync(join(repositoryRoot, "packages/capabilities/src/providers.ts"))).toBe(false);

  const forbiddenIdentities = [
    /\/integrations\/presets\b/,
    /\bCORE_PROVIDER_PRESETS\b/,
    /\bauthorizedPresetIds\b/,
    /\blistApiIntegrationPresets\b/,
    /\bpresetId\b/,
    /\bintegrationId\b/,
    /kind:\s*["']preset["']/,
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

  const definitions = readFileSync(
    join(repositoryRoot, "packages/capabilities/src/integration-definitions.ts"),
    "utf8",
  );
  const apiRoutes = readFileSync(
    join(repositoryRoot, "apps/api/src/routes/api-integrations.ts"),
    "utf8",
  );
  const sdkClient = readFileSync(join(repositoryRoot, "packages/sdk/src/client.ts"), "utf8");

  expect(definitions).toContain("export interface IntegrationDefinition");
  expect(definitions).toContain("CORE_INTEGRATION_DEFINITIONS");
  expect(apiRoutes).toContain("/v1/workspaces/:workspaceId/integrations/definitions");
  expect(sdkClient).toContain("listIntegrationDefinitions");
});
