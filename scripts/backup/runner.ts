import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKUP_TAG,
  COMPLETE_TAG,
  RUN_TAG_PREFIX,
  checkAge,
  expectedFiles,
  groupRuns,
  newRunId,
  newestComplete,
  parseEnvironment,
  retainedRuns,
  type BackupConfig,
  type ResticSnapshot,
  type Run,
} from "./config";
import { CommandError, fanout, run, type Command } from "./process";

type Summary = { snapshot_id?: string; data_added?: number; data_added_packed?: number };
export type RunResult = {
  status: "COMPLETE";
  run: string;
  files: { name: string; snapshot: string; bytes: number; added: number; addedPacked?: number }[];
  forgottenRuns: number;
};

function pg(binary: string, service: string, args: string[]): Command {
  return { binary, args, env: { ...process.env, PGSERVICE: service, PGCONNECT_TIMEOUT: "15" } };
}

export class BackupRunner {
  private storageEnvironment: Record<string, string> | null = null;
  constructor(readonly config: BackupConfig) {}

  private async resticEnv(): Promise<NodeJS.ProcessEnv> {
    this.storageEnvironment ??= this.config.environmentFile
      ? parseEnvironment(await readFile(this.config.environmentFile, "utf8"))
      : {};
    return {
      ...process.env,
      ...this.storageEnvironment,
      RESTIC_REPOSITORY: this.config.repository,
      RESTIC_PASSWORD_FILE: this.config.passwordFile,
      RESTIC_CACHE_DIR: join(this.config.stateDirectory, "cache"),
      // restic reads snapshot times in local time.
      TZ: this.config.timeZone,
    };
  }
  private async restic(args: string[]): Promise<Command> {
    return { binary: "restic", args, env: await this.resticEnv() };
  }
  private async resticOutput(args: string[]): Promise<string> {
    return run([await this.restic(args)], { collect: true });
  }

  /** Create the repository once. Runs never create one implicitly. */
  async init(): Promise<void> {
    await this.resticOutput(["init"]);
    console.log("Initialized the backup repository; store its password independently.");
  }
  private async open(): Promise<void> {
    try {
      await this.resticOutput(["cat", "config"]);
    } catch (error) {
      if (error instanceof CommandError && error.exitCode === 10)
        throw Error("The backup repository does not exist; run `init` once", { cause: error });
      if (error instanceof CommandError && error.exitCode === 12)
        throw Error("Wrong backup repository password", { cause: error });
      throw error;
    }
  }
  async runs(): Promise<Run[]> {
    const snapshots = JSON.parse(
      await this.resticOutput([
        "snapshots",
        "--json",
        "--host",
        this.config.host,
        "--tag",
        BACKUP_TAG,
      ]),
    ) as ResticSnapshot[] | null;
    return groupRuns(snapshots ?? [], this.config);
  }
  private async forget(snapshots: string[]): Promise<void> {
    for (let i = 0; i < snapshots.length; i += 100)
      await this.resticOutput(["forget", ...snapshots.slice(i, i + 100)]);
  }

  async backup(): Promise<RunResult> {
    await this.open();
    // Only stale locks (a killed run) are removed; one writer is enforced by flock.
    await this.resticOutput(["unlock"]);
    const id = newRunId();
    const result: RunResult = { status: "COMPLETE", run: id, files: [], forgottenRuns: 0 };
    try {
      for (const name of expectedFiles(this.config)) {
        console.log(`Dumping ${name}`);
        const db = this.config.databases.find((d) => `${d.name}.dump` === name);
        // Uncompressed, so unchanged data stays byte-identical between nights
        // and restic stores it once; restic compresses and encrypts.
        const source = db
          ? pg("pg_dump", db.service, ["--format=custom", "--compress=0", "--no-owner"])
          : pg("pg_dumpall", this.config.rolesService!, [
              "--roles-only",
              // Unlike pg_dump, pg_dumpall otherwise chooses postgres/template1
              // even when PGSERVICE specifies a different database.
              `--database=service=${this.config.rolesService!}`,
              "--no-password",
            ]);
        const store = await this.restic([
          "backup",
          "--stdin",
          "--stdin-filename",
          name,
          "--host",
          this.config.host,
          "--tag",
          BACKUP_TAG,
          "--tag",
          `${RUN_TAG_PREFIX}${id}`,
          "--json",
          "--quiet",
        ]);
        // Parse the whole archive as it streams in, so a run is complete only
        // when the stored bytes are a readable archive.
        const consumers = db
          ? [store, { binary: "pg_restore", args: ["--file=/dev/null"] }]
          : [store];
        const [stored] = await fanout(source, consumers);
        const summary = stored!
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Summary & { message_type?: string })
          .find((message) => message.message_type === "summary");
        if (!summary?.snapshot_id) throw Error(`No snapshot recorded for ${name}`);
        result.files.push({
          name,
          snapshot: summary.snapshot_id,
          bytes: 0,
          added: summary.data_added ?? 0,
          ...(summary.data_added_packed === undefined
            ? {}
            : { addedPacked: summary.data_added_packed }),
        });
      }
      await this.resticOutput([
        "tag",
        "--add",
        COMPLETE_TAG,
        ...result.files.map((file) => file.snapshot),
      ]);
    } catch (error) {
      // A partial run is never a recovery point; drop what it stored.
      const partial = (await this.runs().catch(() => [])).find((entry) => entry.id === id);
      if (partial)
        await this.forget(partial.files.map((file) => file.snapshot)).catch(() =>
          console.error(`Partial run ${id} needs cleanup`),
        );
      throw error;
    }
    const runs = await this.runs();
    const current = runs.find((entry) => entry.id === id);
    if (!current?.complete) throw Error("The new run is not complete in the repository");
    // Tagging rewrites snapshot records, so take their current IDs.
    for (const file of result.files) {
      const stored = current.files.find((f) => f.name === file.name)!;
      file.snapshot = stored.snapshot;
      file.bytes = stored.bytes;
    }
    // Retention per run; failed runs from earlier attempts are dropped too.
    const keep = retainedRuns(runs, this.config);
    const obsolete = runs.filter((entry) => !keep.has(entry.id));
    if (obsolete.length > 0) {
      await this.forget(obsolete.flatMap((entry) => entry.files.map((file) => file.snapshot)));
      // Repacking rewrites live data; tolerate some unused space instead.
      await this.resticOutput(["prune", "--max-unused", "20%"]);
    }
    result.forgottenRuns = obsolete.length;
    console.log(JSON.stringify(result));
    return result;
  }

  /** Freshness of the newest complete run plus a structural repository check. */
  async check(): Promise<Run> {
    await this.open();
    const latest = checkAge(newestComplete(await this.runs()));
    await this.resticOutput(["check"]);
    return latest;
  }

  /** Also read the newest run back in full and parse every archive. */
  async verify(): Promise<Run> {
    const latest = await this.check();
    for (const file of latest.files) {
      const dump = await this.restic(["dump", file.snapshot, `/${file.name}`]);
      await run(
        file.name.endsWith(".dump")
          ? [dump, { binary: "pg_restore", args: ["--file=/dev/null"] }]
          : [dump],
      );
      console.log(`Verified ${file.name}`);
    }
    return latest;
  }

  async restore(runId: string, name: string, targetService: string): Promise<void> {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(targetService)) throw Error("Invalid target service");
    if (
      this.config.databases.some((db) => db.service === targetService) ||
      this.config.rolesService === targetService
    ) {
      throw Error("Restore target must not be a configured source service");
    }
    await this.open();
    const runs = await this.runs();
    const selected =
      runId === "latest" ? newestComplete(runs) : runs.find((r) => r.id === runId && r.complete);
    if (!selected) throw Error("No such complete recovery point");
    const file = selected.files.find((f) => f.name === `${name}.dump`);
    if (!file) throw Error("Database not present in selected recovery point");
    const empty = await run(
      [
        pg("psql", targetService, [
          "-X",
          "-A",
          "-t",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema';",
        ]),
      ],
      { collect: true },
    );
    if (empty.trim() !== "0") throw Error("Restore requires an empty isolated target database");
    // restic verifies every blob it reads; one transaction rolls back on any error.
    await run([
      await this.restic(["dump", file.snapshot, `/${file.name}`]),
      pg("pg_restore", targetService, [
        "--exit-on-error",
        "--single-transaction",
        `--dbname=service=${targetService}`,
      ]),
    ]);
    console.log(
      `Restored ${name} from run ${selected.id}; validate the application before enabling writers`,
    );
  }
}

export async function prepareState(config: BackupConfig): Promise<void> {
  process.umask(0o077);
  await mkdir(join(config.stateDirectory, "cache"), { recursive: true, mode: 0o700 });
}
