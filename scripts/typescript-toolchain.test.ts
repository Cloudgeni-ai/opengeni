import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

const root = resolve(import.meta.dir, "..");
const legacyCommand =
  /(?:^|[\s;&|"'])(?:[^\s"']*[/\\])?(?:tsc|vue-tsc|tsgo)(?:\.[cm]?js)?(?=$|[\s;&|"'])/u;

test("compiler command regression detector recognizes direct and wrapped legacy launchers", () => {
  for (const command of [
    "tsc --noEmit",
    "bun x tsc",
    "node node_modules/typescript/bin/tsc",
    "sh -c 'vue-tsc --noEmit'",
    "tsgo -p .",
  ]) {
    expect(legacyCommand.test(command)).toBe(true);
  }
  for (const command of ["tsrs --noEmit", "node node_modules/tsrs/bin/tsrs", "tsc-provider-item"]) {
    expect(legacyCommand.test(command)).toBe(false);
  }
});

test("repository compiler launchers and generated consumers use only tsrs", async () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  expect(tracked.exitCode).toBe(0);
  const violations: string[] = [];
  const manifests: {
    path: string;
    manifest: { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  }[] = [];
  for (const path of tracked.stdout.toString().split("\0").filter(Boolean)) {
    if (path.endsWith("package.json")) {
      const manifest = JSON.parse(await readFile(resolve(root, path), "utf8"));
      manifests.push({ path, manifest });
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        if (legacyCommand.test(String(command))) violations.push(`${path}#${name}: ${command}`);
      }
    } else if (/\.(?:sh|ya?ml)$/u.test(path)) {
      const source = await readFile(resolve(root, path), "utf8");
      for (const line of source
        .split("\n")
        .filter((candidate) => !candidate.trimStart().startsWith("#"))) {
        if (legacyCommand.test(line)) violations.push(`${path}: ${line.trim()}`);
      }
    } else if (
      /\.[cm]?[jt]sx?$/u.test(path) &&
      !path.endsWith(".gen.ts") &&
      path !== "scripts/typescript-toolchain.test.ts"
    ) {
      const source = await readFile(resolve(root, path), "utf8");
      if (!legacyCommand.test(source) && !source.includes("typescript/")) continue;
      const parsed = parseSync(path, source);
      expect(parsed.errors, path).toEqual([]);
      const inspect = (value: string) => {
        if (
          legacyCommand.test(value) ||
          /^typescript\/(?:unstable\/(?:sync|async)|lib\/(?:typescript|_?tsc))/u.test(value)
        ) {
          violations.push(`${path}: ${value}`);
        }
      };
      new Visitor({
        Literal(node) {
          if (typeof node.value === "string") inspect(node.value);
        },
        TemplateElement(node) {
          if (node.value.cooked) inspect(node.value.cooked);
        },
      }).visit(parsed.program);
    }
  }
  expect(violations).toEqual([]);
  const canonical = manifests.find(({ path }) => path === "package.json")!.manifest.devDependencies!
    .tsrs;
  expect(canonical).toMatch(/^\d+\.\d+\.\d+-ts\d+\.\d+\.\d+-dev\.\d+$/u);
  for (const { path, manifest } of manifests) {
    if (manifest.devDependencies?.tsrs)
      expect({ path, version: manifest.devDependencies.tsrs }).toEqual({
        path,
        version: canonical,
      });
  }
});
