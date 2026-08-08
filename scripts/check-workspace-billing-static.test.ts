import { describe, expect, test } from "bun:test";
import { checkForbiddenProviderImports, type Finding } from "./check-workspace-billing-static";

async function findingsFor(file: string, source: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  await checkForbiddenProviderImports(file, source, findings);
  return findings;
}

describe("workspace provider import guard", () => {
  test("ignores dependency names that are bundler configuration data", async () => {
    const findings = await findingsFor(
      "scripts/build-runtime-processes.ts",
      'const external = ["better-auth", "better-auth/*", "@better-auth/*", "stripe"];',
    );

    expect(findings).toEqual([]);
  });

  test.each([
    'import { betterAuth } from "better-auth";',
    'import "better-auth/plugins";',
    'const plugin = await import("@better-auth/core");',
    'const adapter = require("@better-auth/adapter");',
  ])("rejects Better Auth module edge: %s", async (source) => {
    const findings = await findingsFor("packages/core/src/example.ts", source);

    expect(findings).toEqual([
      {
        file: "packages/core/src/example.ts",
        message: "imports Better Auth outside the managed auth module",
      },
    ]);
  });

  test("rejects Stripe module edges outside billing provider code", async () => {
    const findings = await findingsFor(
      "apps/api/src/routes/example.ts",
      'import Stripe from "stripe";',
    );

    expect(findings).toEqual([
      {
        file: "apps/api/src/routes/example.ts",
        message: "imports Stripe outside billing route/provider code",
      },
    ]);
  });

  test("retains the managed auth type-only exception", async () => {
    const findings = await findingsFor(
      "packages/core/src/managed-auth-type.ts",
      'import type { Auth } from "better-auth";',
    );

    expect(findings).toEqual([]);
  });
});
