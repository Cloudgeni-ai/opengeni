#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = process.cwd();
const repoRoot = resolve(import.meta.dir, "..");
const generatedDirectory = join(packageRoot, ".opengeni");
const generatedConfig = join(generatedDirectory, "tsconfig.declarations.json");

mkdirSync(generatedDirectory, { recursive: true });
writeFileSync(
  generatedConfig,
  `${JSON.stringify(
    {
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        composite: false,
        incremental: false,
        rootDir: "../src",
        outDir: "../dist",
        paths: {},
      },
      include: ["../src/**/*.ts", "../src/**/*.tsx"],
      exclude: ["../src/**/*.test.ts", "../src/**/*.test.tsx"],
    },
    null,
    2,
  )}\n`,
);

try {
  const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, ["--project", generatedConfig], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(generatedConfig, { force: true });
}
