#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
    cmd: ["bun", tscPath, "--project", declarationConfigPath],
    cwd: packageDirectory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(`TypeScript declaration emit failed with exit code ${status}`);
  }
  await rewriteDeclarationModuleSpecifiers(join(packageDirectory, "dist"));
} finally {
  await rm(declarationConfigPath, { force: true });
}

/**
 * TypeScript preserves extensionless source specifiers in emitted declarations,
 * but strict NodeNext consumers require relative ESM specifiers to name the
 * runtime `.js` path. Resolve each declaration edge before rewriting it so
 * string-literal types and already-qualified assets remain untouched.
 */
async function rewriteDeclarationModuleSpecifiers(directory: string): Promise<void> {
  for (const path of await declarationFiles(directory)) {
    const source = await readFile(path, "utf8");
    const rewritten = source.replace(
      /(["'])(\.\.?(?:\/[^"'?#]+)?)\1/gu,
      (literal, quote: string, specifier: string, offset: number) => {
        const prefix = source.slice(Math.max(0, offset - 48), offset);
        if (!/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bmodule\s*)$/u.test(prefix)) {
          return literal;
        }
        const target = resolve(dirname(path), specifier);
        if (existsSync(`${target}.d.ts`)) return `${quote}${specifier}.js${quote}`;
        if (existsSync(join(target, "index.d.ts"))) {
          return `${quote}${specifier}/index.js${quote}`;
        }
        return literal;
      },
    );
    if (rewritten !== source) await writeFile(path, rewritten, "utf8");
  }
}

async function declarationFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await declarationFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) paths.push(path);
  }
  return paths;
}
