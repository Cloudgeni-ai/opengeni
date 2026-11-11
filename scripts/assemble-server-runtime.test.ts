import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  API_RUNTIME_EXTERNALS,
  API_RUNTIME_COMMAND_ENTRIES,
  API_RUNTIME_PACKAGE_SCRIPTS,
  WORKER_RUNTIME_EXTERNALS,
  DATABASE_COMMAND_RUNNERS,
  finalizeCommandEntry,
} from "./assemble-server-runtime";
import { PACKAGE_ASSET_RUNTIME_EXTERNALS } from "./build-runtime-processes";

const repositoryRoot = resolve(import.meta.dir, "..");

const guardedSource =
  "export async function runMigrateCli() {}\nif (import.meta.main) await runMigrateCli();\n";

test("the API image keeps the model catalog upsert command the ops workflow runs", () => {
  expect(API_RUNTIME_PACKAGE_SCRIPTS).toContain("model-catalog:upsert");
  expect(API_RUNTIME_COMMAND_ENTRIES.map(([, path]) => path)).toContain(
    "scripts/upsert-model-catalog.ts",
  );
});

test("every kept API root script resolves to a file the image bundles", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const bundled = new Set(API_RUNTIME_COMMAND_ENTRIES.map(([, path]) => path));
  for (const script of API_RUNTIME_PACKAGE_SCRIPTS) {
    const command = manifest.scripts[script];
    expect(command, script).toBeString();
    // A root script that runs a repository script directly needs that script
    // bundled at the same path, or `bun run <script>` fails in the image.
    for (const [, path] of command!.matchAll(/\bbun (scripts\/[\w.-]+\.ts)\b/g)) {
      expect(bundled.has(path!), `${script} runs ${path}`).toBe(true);
    }
  }
});

test("only the worker image retains the native Documents parser", () => {
  expect(API_RUNTIME_EXTERNALS).not.toContain("@llamaindex/liteparse");
  expect(WORKER_RUNTIME_EXTERNALS).toContain("@llamaindex/liteparse");
  expect(API_RUNTIME_EXTERNALS).toContain("sharp");
  expect(API_RUNTIME_EXTERNALS).toContain("ws");
  expect(WORKER_RUNTIME_EXTERNALS).toContain("ws");
});

test("both images ship the 1Password SDK as a package, so its WASM core travels with it", () => {
  // The bundles leave it external; the closures must then carry it.
  expect(PACKAGE_ASSET_RUNTIME_EXTERNALS).toContain("@1password/sdk");
  expect(API_RUNTIME_EXTERNALS).toContain("@1password/sdk");
  expect(WORKER_RUNTIME_EXTERNALS).toContain("@1password/sdk");
});

test("both images ship the Keeper SDK as a package; its adapter reads the installed build", () => {
  expect(PACKAGE_ASSET_RUNTIME_EXTERNALS).toContain("@keeper-security/secrets-manager-core");
  expect(API_RUNTIME_EXTERNALS).toContain("@keeper-security/secrets-manager-core");
  expect(WORKER_RUNTIME_EXTERNALS).toContain("@keeper-security/secrets-manager-core");
});

describe("finalizeCommandEntry", () => {
  test("keeps an entry whose own output still carries its guard", () => {
    const output = 'import"./runtime-a.js";if(import.meta.main)await main();\n';
    expect(
      finalizeCommandEntry({ command: "inventory-tenancy", source: guardedSource, output }),
    ).toBe(output);
  });

  test("calls the registered runner when splitting moved the guard into a shared chunk", () => {
    const output =
      'import{migrate,runMigrateCli}from"./runtime-a.js";export{migrate,runMigrateCli};\n';
    const finalized = finalizeCommandEntry({
      command: "migrate",
      source: guardedSource,
      output,
      runner: DATABASE_COMMAND_RUNNERS.migrate!,
    });
    expect(finalized.endsWith("\nif (import.meta.main) await runMigrateCli();\n")).toBe(true);
  });

  test("runs the command when executed, never when imported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "finalize-command-entry-"));
    try {
      await writeFile(
        join(directory, "runtime-a.js"),
        'export async function runMigrateCli() { console.log("COMMAND RAN"); }\n',
      );
      const entry = join(directory, "migrate.js");
      await writeFile(
        entry,
        finalizeCommandEntry({
          command: "migrate",
          source: guardedSource,
          output: 'import{runMigrateCli}from"./runtime-a.js";export{runMigrateCli};\n',
          runner: "runMigrateCli",
        }),
      );
      const executed = Bun.spawnSync([process.execPath, entry], { cwd: directory });
      expect(executed.exitCode).toBe(0);
      expect(executed.stdout.toString()).toBe("COMMAND RAN\n");
      const imported = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(entry)}); console.log(typeof m.runMigrateCli);`,
        ],
        { cwd: directory },
      );
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout.toString()).toBe("function\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses an entry that would silently do nothing", () => {
    const output = 'import{migrate}from"./runtime-a.js";export{migrate};\n';
    expect(() =>
      finalizeCommandEntry({ command: "migrate", source: guardedSource, output }),
    ).toThrow(/lost its import.meta.main entry/);
    expect(() =>
      finalizeCommandEntry({
        command: "migrate",
        source: guardedSource,
        output,
        runner: "runMigrateCli",
      }),
    ).toThrow(/does not import its runner/);
  });

  test("leaves unguarded modules alone", () => {
    const output = "export const x=1;\n";
    expect(finalizeCommandEntry({ command: "x", source: "export const x = 1;\n", output })).toBe(
      output,
    );
  });
});
