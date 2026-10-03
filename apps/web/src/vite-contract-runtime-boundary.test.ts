import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";

describe("web contract runtime chunk boundary", () => {
  test("initializes permission groups before shared organization access fields", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "settings-pages",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const settingsTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      for (const relative of [
        "lib/api-key-presets.ts",
        "lib/api-key-status.ts",
        "lib/organization-access.ts",
        "components/organization-access/organization-access-fields.tsx",
        "components/organization-api-keys-section.tsx",
      ]) {
        expect(settingsTest.test(moduleId(relative))).toBe(true);
      }
      for (const relative of [
        "context.tsx",
        "lib/permissions.ts",
        "routes/connect-agent.tsx",
        "components/organization-access/mcp-consent-page.tsx",
        "components/organization-access/connected-agents.tsx",
      ]) {
        expect(settingsTest.test(moduleId(relative))).toBe(false);
      }
    }
    const membersPriority = config.match(
      /name: "workspace-members",[\s\S]*?priority: (\d+),/u,
    )?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(membersPriority));
  });

  test("initializes Permission before eager organization-access consumers", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "zod-runtime",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const runtimeTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      for (const relative of [
        "node_modules/zod/v4/core/index.js",
        "node_modules/.bun/zod@4.4.3/node_modules/zod/v4/core/index.js",
        "packages/contracts/src/skills.ts",
        "packages/contracts/src/permissions.ts",
      ]) {
        expect(runtimeTest.test(moduleId(relative))).toBe(true);
      }
      for (const relative of [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/organization-access.ts",
        "packages/contracts/src/external-identities.ts",
        "apps/web/src/lib/permissions.ts",
        "apps/web/src/routes/workspace-members-section.tsx",
      ]) {
        expect(runtimeTest.test(moduleId(relative))).toBe(false);
      }
    }
    const membersPriority = config.match(
      /name: "workspace-members",[\s\S]*?priority: (\d+),/u,
    )?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(membersPriority));

    // This eager enum must not import the barrel or its consumers back.
    const source = await readFile(
      new URL("../../../packages/contracts/src/permissions.ts", import.meta.url),
      "utf8",
    );
    const { program, errors } = parseSync("permissions.ts", source);
    expect(errors).toEqual([]);
    const imports = program.body.flatMap((node) =>
      node.type === "ImportDeclaration" && node.importKind !== "type" ? [node.source.value] : [],
    );
    expect(imports).toEqual(["zod"]);
  });
});
