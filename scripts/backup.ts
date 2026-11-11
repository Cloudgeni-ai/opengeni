#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseConfig } from "./backup/config";
import { BackupRunner, prepareState } from "./backup/runner";

const modes = ["init", "run", "list", "check", "verify", "restore"];
const usage =
  "Usage: bun run deployment:backup <init|run|list|check|verify|restore> --config <path> [--run latest|<run-id> --database <name> --target-service <isolated-target> --confirm-restore]";
export async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const [mode, ...rest] = args;
  if (!mode || !modes.includes(mode)) throw Error(usage);
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === "--confirm-restore") {
      options[key] = "true";
      continue;
    }
    if (
      !["--config", "--run", "--database", "--target-service"].includes(key) ||
      options[key] ||
      !rest[i + 1] ||
      rest[i + 1]!.startsWith("--")
    )
      throw Error(usage);
    options[key] = rest[++i]!;
  }
  if (!options["--config"]) throw Error(usage);
  const config = parseConfig(JSON.parse(await readFile(options["--config"], "utf8")) as unknown);
  await prepareState(config);
  // A persistent OS lock survives neither process death nor reboot; no stale PID
  // files. restic's own repository lock also guards the repository.
  if (process.env.OPENGENI_BACKUP_LOCK_HELD !== config.stateDirectory) {
    const child = spawn(
      "flock",
      [
        "--nonblock",
        join(config.stateDirectory, "backup.lock"),
        process.execPath,
        import.meta.path,
        ...args,
      ],
      {
        env: { ...process.env, OPENGENI_BACKUP_LOCK_HELD: config.stateDirectory },
        stdio: "inherit",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.on("error", () => reject(Error("Unable to start backup lock (flock required)")));
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Backup command failed (${code}); another invocation may hold the lock`)),
      );
    });
    return;
  }
  const runner = new BackupRunner(config);
  if (mode === "init") return runner.init();
  if (mode === "restore") {
    if (!options["--database"] || !options["--target-service"] || !options["--confirm-restore"])
      throw Error(usage);
    await runner.restore(
      options["--run"] ?? "latest",
      options["--database"],
      options["--target-service"],
    );
    return;
  }
  if (mode === "run") {
    await runner.backup();
    return;
  }
  const result =
    mode === "list"
      ? await runner.runs()
      : mode === "check"
        ? await runner.check()
        : await runner.verify();
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Backup failed");
    process.exitCode = 1;
  });
}
