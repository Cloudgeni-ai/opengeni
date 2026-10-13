import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_COMMAND_RUNNERS, finalizeCommandEntry } from "./assemble-server-runtime";

const guardedSource =
  "export async function runMigrateCli() {}\nif (import.meta.main) await runMigrateCli();\n";

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
