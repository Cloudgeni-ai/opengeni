import { resolve } from "node:path";

export type BackupConfig = {
  /** Restic repository, for example `s3:https://host/bucket/prefix` or `/srv/backups`. */
  repository: string;
  /** File holding the repository password. */
  passwordFile: string;
  /** Optional KEY=VALUE file with storage credentials, passed only to restic. */
  environmentFile?: string | undefined;
  stateDirectory: string;
  /** Snapshot host name; separates deployments that share one repository. */
  host: string;
  databases: { name: string; service: string }[];
  rolesService?: string | undefined;
  timeZone: string;
  retention: { daily: number; weekly: number };
};
/** One stored file of a run: a database archive or the roles script. */
export type RunFile = { name: string; snapshot: string; bytes: number };
export type Run = { id: string; time: string; complete: boolean; files: RunFile[] };
export type ResticSnapshot = {
  id: string;
  short_id?: string;
  time: string;
  hostname: string;
  paths: string[];
  tags?: string[];
  summary?: { total_bytes_processed?: number };
};

export const BACKUP_TAG = "opengeni-backup";
export const COMPLETE_TAG = "complete";
export const RUN_TAG_PREFIX = "run=";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value))
    throw Error(`Invalid ${field}`);
  return value;
}
function absolute(value: unknown, field: string): string {
  const path = text(value, field);
  if (resolve(path) !== path || path === "/") throw Error(`${field} must be an absolute path`);
  return path;
}
function count(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1000)
    throw Error(`Invalid ${field}`);
  return value;
}
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

export function parseConfig(value: unknown): BackupConfig {
  const input = record(value);
  const repository = text(input.repository, "repository");
  // A local path or a restic backend URL (s3:, azure:, gs:, b2:, rest:, rclone:, ...).
  // Never an option: the value is passed to restic as one argument.
  if (
    repository.startsWith("-") ||
    !(repository.startsWith("/") || /^[a-z0-9]+:\S+$/.test(repository))
  )
    throw Error("repository must be a restic repository URL or an absolute path");
  if (repository.startsWith("/") && resolve(repository) !== repository)
    throw Error("repository path must be normalized");
  if (!Array.isArray(input.databases) || input.databases.length === 0)
    throw Error("Configure at least one database");
  const databases = input.databases.map((entry: unknown) => {
    const db = record(entry);
    const name = text(db.name, "database name");
    const service = text(db.service, "libpq service");
    if (!identifier.test(name) || !identifier.test(service))
      throw Error("Database and libpq service names must be simple identifiers");
    if (name === "roles") throw Error("'roles' is reserved for the roles script");
    return { name, service };
  });
  if (new Set(databases.map((db) => db.name)).size !== databases.length)
    throw Error("Duplicate database name");
  if (new Set(databases.map((db) => db.service)).size !== databases.length)
    throw Error("Duplicate database service");
  const rolesService =
    input.rolesService === undefined ? undefined : text(input.rolesService, "rolesService");
  if (rolesService && !identifier.test(rolesService)) throw Error("Invalid roles service");
  const host = input.host === undefined ? "opengeni" : text(input.host, "host");
  if (!identifier.test(host)) throw Error("host must be a simple identifier");
  const timeZone = input.timeZone === undefined ? "UTC" : text(input.timeZone, "timeZone");
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  const retentionInput = input.retention === undefined ? {} : record(input.retention);
  const retention = {
    daily: count(retentionInput.daily, 7, "retention.daily"),
    weekly: count(retentionInput.weekly, 4, "retention.weekly"),
  };
  if (retention.daily < 1) throw Error("retention.daily must keep at least one point");
  return {
    repository,
    passwordFile: absolute(input.passwordFile, "passwordFile"),
    environmentFile:
      input.environmentFile === undefined
        ? undefined
        : absolute(input.environmentFile, "environmentFile"),
    stateDirectory: absolute(input.stateDirectory, "stateDirectory"),
    host,
    databases,
    rolesService,
    timeZone,
    retention,
  };
}

/** The files one complete run stores, by snapshot path name. */
export function expectedFiles(config: BackupConfig): string[] {
  return [
    ...config.databases.map((db) => `${db.name}.dump`),
    ...(config.rolesService ? ["roles.sql"] : []),
  ];
}

/** Parse a KEY=VALUE storage credential file. Values are taken literally. */
export function parseEnvironment(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = at < 0 ? "" : line.slice(0, at).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw Error("Invalid environment file entry");
    // The password stays in passwordFile; the repository stays in the config.
    if (key.startsWith("RESTIC_") || key === "PATH")
      throw Error(`${key} does not belong in the environment file`);
    result[key] = line.slice(at + 1);
  }
  return result;
}

/** Group this host's snapshots into runs. A run is complete only when every expected file carries the complete tag. */
export function groupRuns(snapshots: ResticSnapshot[], config: BackupConfig): Run[] {
  const expected = expectedFiles(config);
  const runs = new Map<string, { time: string; files: Map<string, ResticSnapshot> }>();
  for (const snapshot of snapshots) {
    if (snapshot.hostname !== config.host || !snapshot.tags?.includes(BACKUP_TAG)) continue;
    const id = snapshot.tags
      .find((tag) => tag.startsWith(RUN_TAG_PREFIX))
      ?.slice(RUN_TAG_PREFIX.length);
    const name = snapshot.paths.length === 1 ? snapshot.paths[0]!.replace(/^\//, "") : "";
    if (!id || !expected.includes(name)) continue;
    const run = runs.get(id) ?? { time: snapshot.time, files: new Map() };
    if (Date.parse(snapshot.time) < Date.parse(run.time)) run.time = snapshot.time;
    const previous = run.files.get(name);
    if (!previous || Date.parse(snapshot.time) > Date.parse(previous.time))
      run.files.set(name, snapshot);
    runs.set(id, run);
  }
  return [...runs.entries()]
    .map(([id, run]) => ({
      id,
      time: run.time,
      complete: expected.every((name) => run.files.get(name)?.tags?.includes(COMPLETE_TAG)),
      files: [...run.files.entries()]
        .sort(([a], [b]) => expected.indexOf(a) - expected.indexOf(b))
        .map(([name, snapshot]) => ({
          name,
          snapshot: snapshot.id,
          bytes: snapshot.summary?.total_bytes_processed ?? 0,
        })),
    }))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function newestComplete(runs: Run[]): Run | undefined {
  return runs.find((run) => run.complete);
}

function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
/** Monday of the local week containing the date, as YYYY-MM-DD. */
export function weekStart(date: Date, timeZone: string): string {
  const d = new Date(`${localDay(date, timeZone)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Complete runs to keep: the newest run of each of the last `daily` days that
 * have one, and of each of the last `weekly` weeks, in the configured time
 * zone. Retention is decided per run, so a kept point always has every file.
 */
export function retainedRuns(runs: Run[], config: BackupConfig): Set<string> {
  const keep = new Set<string>();
  const complete = runs
    .filter((run) => run.complete)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  for (const [limit, bucket] of [
    [config.retention.daily, (date: Date) => localDay(date, config.timeZone)],
    [config.retention.weekly, (date: Date) => weekStart(date, config.timeZone)],
  ] as const) {
    const seen = new Set<string>();
    for (const run of complete) {
      const key = bucket(new Date(run.time));
      if (seen.has(key)) continue;
      if (seen.size >= limit) break;
      seen.add(key);
      keep.add(run.id);
    }
  }
  return keep;
}

export function checkAge(run: Run | undefined, now = new Date()): Run {
  if (!run) throw Error("No complete backup exists");
  const age = now.getTime() - Date.parse(run.time);
  if (age < -5 * 60000 || age > 36 * 3600000) throw Error("Newest backup is stale (>36 hours)");
  return run;
}

export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, "");
}
