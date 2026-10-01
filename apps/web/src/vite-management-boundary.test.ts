import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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

  test("keeps the shared scheduling glyph out of management entry-aware chunks", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "session-shared-primitives",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const primitiveTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      expect(
        primitiveTest.test(moduleId("node_modules/lucide-react/dist/esm/icons/calendar-clock.mjs")),
      ).toBe(true);
      for (const module of ["diff-view", "revision-history", "error-message"]) {
        expect(primitiveTest.test(moduleId(`apps/web/src/components/ui/${module}.tsx`))).toBe(
          false,
        );
      }
    }
    const sessionPriority = config.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(sessionPriority));
  });
});
