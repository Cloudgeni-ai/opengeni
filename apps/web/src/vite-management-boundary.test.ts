import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";

describe("web management chunk boundary", () => {
  test("splits mixed-consumer form primitives without merging management helpers into sessions", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "workspace-form-primitives",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    expect(group?.[0]).toContain("entriesAware: true");
    expect(group?.[0]).toContain("entriesAwareMergeThreshold: 4 * 1024");
    const formTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      for (const module of [
        "components/ui/dialog.tsx",
        "components/ui/textarea.tsx",
        "components/settings/organization-workspace-administration.tsx",
      ]) {
        expect(formTest.test(moduleId(module))).toBe(true);
      }
      for (const module of [
        "routes/session.tsx",
        "routes/workspace-settings.tsx",
        "components/organization-api-keys-section.tsx",
      ]) {
        expect(formTest.test(moduleId(module))).toBe(false);
      }
    }
    const members = config.match(/name: "workspace-members",[\s\S]*?priority: (\d+),/u);
    expect(members?.[0]).toContain("entriesAware: true");
    expect(members?.[0]).toContain("entriesAwareMergeThreshold: 24 * 1024");
    expect(Number(group?.[1])).toBeGreaterThan(Number(members?.[1]));
  });

  test("keeps organization API-key setup behind the existing lazy settings group", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "settings-pages",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const settingsTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      for (const module of [
        "components/organization-api-keys-section.tsx",
        "routes/workspace-api-keys.tsx",
        "lib/api-key-presets.ts",
        "lib/api-key-status.ts",
      ]) {
        expect(settingsTest.test(moduleId(module))).toBe(true);
      }
      for (const module of ["routes/session.tsx", "context.tsx", "lib/permissions.ts"]) {
        expect(settingsTest.test(moduleId(module))).toBe(false);
      }
    }
    const sessionPriority = config.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(sessionPriority));

    const source = await readFile(new URL("./routes/org-settings.tsx", import.meta.url), "utf8");
    const { program, errors } = parseSync("org-settings.tsx", source);
    expect(errors).toEqual([]);
    const imports = program.body
      .filter((node) => node.type === "ImportDeclaration")
      .map((node) => node.source.value);
    expect(imports).not.toContain("@/components/organization-api-keys-section");
    expect(source).toContain('import("@/components/organization-api-keys-section")');
  });

  test("keeps payment and identity glyphs behind settings without capturing shared session glyphs", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "settings-pages",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const settingsTest = new RegExp(pattern!);
    const sharedGroup = config.match(/name: "session-shared-primitives",[\s\S]*?priority: (\d+),/u);
    const sharedPattern = sharedGroup?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(sharedPattern).toBeDefined();
    const sharedTest = new RegExp(sharedPattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      const iconId = (icon: string) =>
        moduleId(`node_modules/lucide-react/dist/esm/icons/${icon}.mjs`);
      for (const icon of ["credit-card", "fingerprint-pattern"]) {
        expect(settingsTest.test(iconId(icon))).toBe(true);
        expect(sharedTest.test(iconId(icon))).toBe(false);
      }
      for (const icon of ["plus", "code-xml", "menu", "gauge"]) {
        expect(settingsTest.test(iconId(icon))).toBe(false);
      }
      expect(sharedTest.test(iconId("plus"))).toBe(true);
      for (const module of [
        "apps/web/src/routes/session.tsx",
        "apps/web/src/components/credit-required-prompt.tsx",
        "node_modules/lucide-react/dist/esm/createLucideIcon.mjs",
      ]) {
        expect(settingsTest.test(moduleId(module))).toBe(false);
      }
    }
    for (const routeGroup of ["session", "workspace-members", "workspace-settings"]) {
      const priority = config.match(
        new RegExp(`name: "${routeGroup}",[\\s\\S]*?priority: (\\d+),`, "u"),
      )?.[1];
      expect(Number(group?.[1])).toBeGreaterThan(Number(priority));
    }
  });

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
