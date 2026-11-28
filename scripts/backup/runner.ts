import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
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
  quoted,
  tablesFile,
  type BackupConfig,
  type DatabaseConfig,
  type ResticSnapshot,
  type Run,
} from "./config";
import { CommandError, concatenate, fanout, hold, run, type Command } from "./process";
import { tablesCheck, tablesScript } from "./tables";

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
const PSQL = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];

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

  /** Stream one file into the repository while `consumers`/`checks` parse the same bytes. */
  private async store(
    id: string,
    name: string,
    source: Command,
    consumers: Command[],
    checks: Writable[] = [],
  ): Promise<RunResult["files"][number]> {
    console.log(`Dumping ${name}`);
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
    const [stored] = await fanout(source, [store, ...consumers], checks);
    const summary = stored!
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Summary & { message_type?: string })
      .find((message) => message.message_type === "summary");
    if (!summary?.snapshot_id) throw Error(`No snapshot recorded for ${name}`);
    return {
      name,
      snapshot: summary.snapshot_id,
      bytes: 0,
      added: summary.data_added ?? 0,
      ...(summary.data_added_packed === undefined
        ? {}
        : { addedPacked: summary.data_added_packed }),
    };
  }

  // Uncompressed, so unchanged data stays byte-identical between nights and
  // restic stores it once; restic compresses and encrypts. The whole archive is
  // parsed as it streams in, so a run is complete only when the stored bytes
  // are a readable archive.
  private dump(db: DatabaseConfig, extra: string[] = []): Command {
    return pg("pg_dump", db.service, ["--format=custom", "--compress=0", "--no-owner", ...extra]);
  }

  /**
   * A database with ordered tables: its archive without those tables' rows,
   * then the rows in key order, both read from one exported snapshot that a
   * held transaction keeps valid (and the tables locked against DDL).
   */
  private async storeOrdered(id: string, db: DatabaseConfig): Promise<RunResult["files"]> {
    const tables = db.orderedTables.map((t) => t.table);
    const holder = await hold(
      pg("psql", db.service, PSQL),
      [
        "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;",
        "SELECT set_config(name, '0', true) FROM pg_settings WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout') \\g /dev/null",
        `LOCK TABLE ${tables.map(quoted).join(", ")} IN ACCESS SHARE MODE;`,
        "SELECT pg_export_snapshot();",
        "",
      ].join("\n"),
      "COMMIT;\n",
    );
    const script = join(this.config.stateDirectory, `ordered-${id}-${db.name}.sql`);
    try {
      const archive = await this.store(
        id,
        `${db.name}.dump`,
        this.dump(db, [
          `--snapshot=${holder.line}`,
          // A quoted pattern names exactly this table.
          ...tables.map((table) => `--exclude-table-data=${quoted(table)}`),
        ]),
        [{ binary: "pg_restore", args: ["--file=/dev/null"] }],
      );
      await writeFile(script, tablesScript(holder.line, db.orderedTables), { mode: 0o600 });
      const rows = await this.store(
        id,
        tablesFile(db.name),
        pg("psql", db.service, [...PSQL, "-f", script]),
        [],
        [tablesCheck(tables)],
      );
      await holder.release();
      return [archive, rows];
    } finally {
      await rm(script, { force: true });
      await holder.release().catch(() => undefined);
    }
  }

  async backup(): Promise<RunResult> {
    await this.open();
    // Only stale locks (a killed run) are removed; one writer is enforced by flock.
    await this.resticOutput(["unlock"]);
    const id = newRunId();
    const result: RunResult = { status: "COMPLETE", run: id, files: [], forgottenRuns: 0 };
    try {
      for (const db of this.config.databases) {
        if (db.orderedTables.length > 0) result.files.push(...(await this.storeOrdered(id, db)));
        else
          result.files.push(
            await this.store(id, `${db.name}.dump`, this.dump(db), [
              { binary: "pg_restore", args: ["--file=/dev/null"] },
            ]),
          );
      }
      if (this.config.rolesService)
        result.files.push(
          await this.store(
            id,
            "roles.sql",
            pg("pg_dumpall", this.config.rolesService, [
              "--roles-only",
              // Unlike pg_dump, pg_dumpall otherwise chooses postgres/template1
              // even when PGSERVICE specifies a different database.
              `--database=service=${this.config.rolesService}`,
              "--no-password",
            ]),
            [],
          ),
        );
      const expected = expectedFiles(this.config);
      if (result.files.map((f) => f.name).join() !== expected.join())
        throw Error("The run did not store the expected files");
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
      if (file.name.endsWith(".tables")) await run([dump], { output: tablesCheck() });
      else
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
    const rows = selected.files.find((f) => f.name === tablesFile(name));
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
    if (!rows)
      await run([
        await this.restic(["dump", file.snapshot, `/${file.name}`]),
        pg("pg_restore", targetService, [
          "--exit-on-error",
          "--single-transaction",
          `--dbname=service=${targetService}`,
        ]),
      ]);
    else {
      // The archive's tables and data, then the ordered tables' rows, then its
      // indexes, constraints, triggers and policies: one psql transaction.
      const archive = async (sections: string[]) => [
        // pg_restore stops reading once it has written its sections.
        { ...(await this.restic(["dump", file.snapshot, `/${file.name}`])), outputMayClose: true },
        {
          binary: "pg_restore",
          args: ["--file=-", ...sections.map((section) => `--section=${section}`)],
        },
      ];
      await concatenate(
        [
          await archive(["pre-data", "data"]),
          [await this.restic(["dump", rows.snapshot, `/${rows.name}`])],
          await archive(["post-data"]),
        ],
        pg("psql", targetService, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"]),
      );
    }
    console.log(
      `Restored ${name} from run ${selected.id}; validate the application before enabling writers`,
    );
  }
}

export async function prepareState(config: BackupConfig): Promise<void> {
  process.umask(0o077);
  await mkdir(join(config.stateDirectory, "cache"), { recursive: true, mode: 0o700 });
}
