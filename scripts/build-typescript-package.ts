#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type TsupOptions = Record<string, unknown> & { dts?: unknown };
type TsupConfigExport =
  | TsupOptions
  | TsupOptions[]
  | ((overrideOptions: TsupOptions) => TsupOptions | TsupOptions[]);

const packageDirectory = process.cwd();
const tsupPath = Bun.resolveSync("tsup", packageDirectory);
const { build } = (await import(pathToFileURL(tsupPath).href)) as {
  build(options: TsupOptions): Promise<unknown>;
};
const configPath = join(packageDirectory, "tsup.config.ts");
const configModule = (await import(pathToFileURL(configPath).href)) as {
  default: TsupConfigExport;
};
const resolvedConfig =
  typeof configModule.default === "function" ? configModule.default({}) : configModule.default;
const configs = Array.isArray(resolvedConfig) ? resolvedConfig : [resolvedConfig];

for (const config of configs) {
  // TypeScript 7 exposes its stable compiler through the tsc CLI. tsup 8's
  // declaration bundler requires the removed legacy compiler API, so retain
  // tsup for JavaScript and source maps while emitting declarations below.
  await build({ ...config, dts: false });
}

const transientDirectory = join(packageDirectory, ".opengeni");
const declarationConfigPath = join(
  transientDirectory,
  `tsconfig.declarations-${randomUUID()}.json`,
);

await mkdir(transientDirectory, { recursive: true });
await writeFile(
  declarationConfigPath,
  `${JSON.stringify(
    {
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        rootDir: "../src",
        outDir: "../dist",
        incremental: false,
        // Published workspace siblings are external package dependencies. Do
        // not follow the development-only source aliases into another root.
        paths: {},
      },
      include: ["../src/**/*.ts", "../src/**/*.tsx"],
      exclude: [],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

try {
  const tscPath = join(import.meta.dir, "../node_modules/typescript/bin/tsc");
  const child = Bun.spawn({
    cmd: ["node", tscPath, "--project", declarationConfigPath],
    cwd: packageDirectory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(`TypeScript declaration emit failed with exit code ${status}`);
  }
} finally {
  await rm(declarationConfigPath, { force: true });
}
