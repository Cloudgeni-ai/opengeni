import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("web app-shell chunk boundary", () => {
  test("coalesces eager route parsers and the scrollbar entry without promoting lazy implementations", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "startup-sdk-runtime",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(group?.[0]).toContain("includeDependenciesRecursively: false");
    const runtimeTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      for (const helper of ["integration-connect-return", "secrets-route", "composer-launch"]) {
        expect(runtimeTest.test(moduleId(`lib/${helper}.ts`))).toBe(true);
      }
      for (const relative of ["scrollbars.ts", "lib/scrollbars.ts"]) {
        expect(
          runtimeTest.test(`/repo/packages/react/src/${relative}`.replaceAll("/", separator)),
        ).toBe(true);
      }
      for (const relative of [
        "routes/secrets.tsx",
        "routes/session.tsx",
        "lib/integration-connect-analytics.ts",
        "components/secrets/vault-model.ts",
        "components/secrets/vault-chooser.tsx",
      ]) {
        expect(runtimeTest.test(moduleId(relative))).toBe(false);
      }
    }
    for (const name of ["session", "workspace-settings", "workspace-members"]) {
      const routePriority = config.match(
        new RegExp(`name: "${name}",[\\s\\S]*?priority: (\\d+),`, "u"),
      )?.[1];
      expect(Number(group?.[1])).toBeGreaterThan(Number(routePriority));
    }
    const uiPriority = config.match(/name: "ui-runtime",[\s\S]*?priority: (\d+),/u)?.[1];
    // The entry uses this group, while the shared probe keeps the stronger
    // existing UI-runtime placement even though both regexes match it.
    expect(Number(uiPriority)).toBeGreaterThan(Number(group?.[1]));
    expect(config).not.toContain('name: "composer-launch"');
  });

  test("keeps the before-paint scrollbar probe in the eager UI runtime", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const group = config.match(/name: "ui-runtime",[\s\S]*?priority: (\d+),/u);
    const pattern = group?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    const runtimeTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      expect(runtimeTest.test(moduleId("packages/react/src/lib/scrollbars.ts"))).toBe(true);
      for (const relative of [
        "packages/react/src/index.ts",
        "packages/react/src/provider.tsx",
        "packages/react/src/components/session-conversation.tsx",
        "apps/web/src/routes/session.tsx",
      ]) {
        expect(runtimeTest.test(moduleId(relative))).toBe(false);
      }
    }
    const sessionPriority = config.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(group?.[1])).toBeGreaterThan(Number(sessionPriority));

    // Pin the small shared probe, not the package barrel or its lazy consumers.
    const probe = await readFile(
      new URL("../../../packages/react/src/lib/scrollbars.ts", import.meta.url),
      "utf8",
    );
    expect(probe).not.toMatch(/^\s*import\s+(?!type\b)/mu);
    expect(probe).not.toMatch(/\b(?:import|require)\s*\(/u);
    expect(probe).not.toMatch(/^\s*export\s+.*\bfrom\s+["']/mu);
    const main = await readFile(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main.indexOf("markClassicScrollbars(document)")).toBeGreaterThan(-1);
    expect(main.indexOf("markClassicScrollbars(document)")).toBeLessThan(
      main.indexOf("createRoot("),
    );
  });

  test("keeps shared search intent in the shell without matching lazy search implementations", async () => {
    const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const appShellBlock = viteConfig.match(/name: "app-shell",[\s\S]*?priority: (\d+),/u);
    const pattern = appShellBlock?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    const shellTest = new RegExp(pattern!);
    const sessionPriority = viteConfig.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(appShellBlock?.[1])).toBeGreaterThan(Number(sessionPriority));

    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) =>
        `/repo/apps/web/src/${relative}`.replaceAll("/", separator);
      expect(shellTest.test(moduleId("lib/session-search-route.ts"))).toBe(true);
      for (const relative of [
        "components/session/session-search-dialog.tsx",
        "components/session/conversation-find.tsx",
        "components/session/search-results-view.tsx",
        "lib/use-conversation-search.ts",
        "lib/use-session-search-resource.ts",
        "routes/session.tsx",
      ]) {
        expect(shellTest.test(moduleId(relative))).toBe(false);
      }
    }

    // app-shell recursively includes dependencies: this shared intent contract
    // must remain a leaf, not gain an import of the dialog or search controller.
    const intent = await readFile(
      new URL("./lib/session-search-route.ts", import.meta.url),
      "utf8",
    );
    expect(intent).not.toMatch(/^\s*import\s+(?!type\b)/mu);
    expect(intent).not.toMatch(/\b(?:import|require)\s*\(/u);
    expect(intent).not.toMatch(/^\s*export\s+.*\bfrom\s+["']/mu);
  });

  test("pins the module behind Lucide's legacy BarChart3 icon alias", async () => {
    const lucidePackagePath = fileURLToPath(import.meta.resolve("lucide-react/package.json"));
    const lucidePackage = JSON.parse(await readFile(lucidePackagePath, "utf8")) as {
      module: string;
    };
    const lucideEntry = await readFile(
      path.resolve(path.dirname(lucidePackagePath), lucidePackage.module),
      "utf8",
    );
    const alias = lucideEntry.match(
      /export \{[^}\n]*\bBarChart3Icon\b[^}\n]*\} from '\.\/icons\/([^']+)\.mjs';/u,
    );
    expect(alias).not.toBeNull();

    const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const appShellBlock = viteConfig.match(
      /name: "app-shell",[\s\S]*?includeDependenciesRecursively:/u,
    )?.[0];
    const appShellTest = appShellBlock
      ?.split("\n")
      .find((line) => line.trimStart().startsWith("test: /"));

    expect(appShellTest).toContain(alias?.[1]);
  });
});
