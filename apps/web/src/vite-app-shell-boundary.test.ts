import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("web app-shell chunk boundary", () => {
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
