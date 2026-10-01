import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";

describe("web management chunk boundary", () => {
  test("keeps revision and diff UI behind the existing lazy management group", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "management-ui-primitives",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const managementTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      for (const module of ["diff-view", "revision-history", "error-message"]) {
        expect(managementTest.test(moduleId(`components/ui/${module}.tsx`))).toBe(true);
      }
      for (const module of [
        "routes/session.tsx",
        "components/rail/session-header.tsx",
        "components/common.tsx",
      ]) {
        expect(managementTest.test(moduleId(module))).toBe(false);
      }
    }
    for (const routeGroup of ["session", "workspace-members", "workspace-settings"]) {
      const priority = config.match(
        new RegExp(`name: "${routeGroup}",[\\s\\S]*?priority: (\\d+),`, "u"),
      )?.[1];
      expect(Number(group?.[1])).toBeGreaterThan(Number(priority));
    }
  });

  test("keeps shared scheduling and usage glyphs out of management entry-aware chunks", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "session-shared-primitives",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const primitiveTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      for (const icon of ["calendar-clock", "gauge"]) {
        expect(
          primitiveTest.test(moduleId(`node_modules/lucide-react/dist/esm/icons/${icon}.mjs`)),
        ).toBe(true);
      }
      for (const module of ["diff-view", "revision-history", "error-message"]) {
        expect(primitiveTest.test(moduleId(`apps/web/src/components/ui/${module}.tsx`))).toBe(
          false,
        );
      }
    }
    const sessionPriority = config.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(sessionPriority));
  });

  test("keeps agent defaults and usage pages as separate lazy settings entries", async () => {
    const source = await readFile(
      new URL("./routes/workspace-settings.tsx", import.meta.url),
      "utf8",
    );
    const { program, errors } = parseSync("workspace-settings.tsx", source);
    expect(errors).toEqual([]);
    const imports = program.body
      .filter((node) => node.type === "ImportDeclaration")
      .map((node) => node.source.value);
    const declarations = program.body.flatMap((node) =>
      node.type === "VariableDeclaration" ? node.declarations : [],
    );
    for (const [name, module] of [
      ["LazySessionDefaultsPage", "@/components/settings/session-defaults-page"],
      ["LazyWorkspaceUsagePage", "@/components/usage/workspace-usage-page"],
    ]) {
      expect(imports).not.toContain(module);
      const declaration = declarations.find(
        (node) => node.id.type === "Identifier" && node.id.name === name,
      );
      expect(declaration?.init).toMatchObject({
        type: "CallExpression",
        callee: { type: "Identifier", name: "lazy" },
      });
      expect(source.slice(declaration?.start ?? 0, declaration?.end ?? 0)).toContain(
        `import("${module}")`,
      );
    }
  });
});
