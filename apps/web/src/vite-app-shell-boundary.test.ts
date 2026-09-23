import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("web app-shell chunk boundary", () => {
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
