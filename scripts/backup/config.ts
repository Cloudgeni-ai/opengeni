import { resolve } from "node:path";

export type BackupConfig = {
  remote: string;
  stateDirectory: string;
  ageRecipient: string;
  ageIdentityFile: string;
  databases: { name: string; service: string }[];
  rolesService?: string | undefined;
  timeZone: string;
};
export type BackupFile = { key: string; bytes: number; sha256: string };
export type Manifest = { run: string; startedAt: string; finishedAt: string; files: BackupFile[] };
export type BackupIndex = { schema: 1; week: string; nightly: Manifest; weekly: Manifest };

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
export function parseConfig(value: unknown): BackupConfig {
  const input = record(value);
  const remote = text(input.remote, "remote").replace(/\/$/, "");
  if (remote.startsWith("-") || remote.includes("..") || !/^[a-zA-Z0-9_-]+:.+/.test(remote)) {
    throw Error("remote must be a dedicated named rclone remote and bucket/prefix");
  }
  const stateDirectory = text(input.stateDirectory, "stateDirectory");
  const ageIdentityFile = text(input.ageIdentityFile, "ageIdentityFile");
  if (
    resolve(stateDirectory) !== stateDirectory ||
    resolve(ageIdentityFile) !== ageIdentityFile ||
    stateDirectory === "/"
  )
    throw Error("State and identity paths must be absolute");
  if (!Array.isArray(input.databases) || input.databases.length === 0)
    throw Error("Configure at least one database");
  const databases = input.databases.map((entry: unknown) => {
    const db = record(entry);
    const name = text(db.name, "database name");
    const service = text(db.service, "libpq service");
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(name) ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(service)
    ) {
      throw Error("Database and libpq service names must be simple identifiers");
    }
    return { name, service };
  });
  if (new Set(databases.map((db) => db.name)).size !== databases.length)
    throw Error("Duplicate database name");
  if (new Set(databases.map((db) => db.service)).size !== databases.length)
    throw Error("Duplicate database service");
  const rolesService =
    input.rolesService === undefined ? undefined : text(input.rolesService, "rolesService");
  if (rolesService && !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(rolesService))
    throw Error("Invalid roles service");
  const timeZone = input.timeZone === undefined ? "UTC" : text(input.timeZone, "timeZone");
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  return {
    remote,
    stateDirectory,
    ageIdentityFile,
    databases,
    rolesService,
    timeZone,
    ageRecipient: text(input.ageRecipient, "ageRecipient"),
  };
}
export function expectedFiles(config: BackupConfig): string[] {
  return [
    ...config.databases.map((db) => `${db.name}.dump.age`),
    ...(config.rolesService ? ["roles.sql.age"] : []),
  ];
}
export function weekStart(date: Date, timeZone: string): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const d = new Date(`${local}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
export function validateManifest(value: unknown, config: BackupConfig): Manifest {
  const m = record(value);
  if (
    typeof m.run !== "string" ||
    !/^runs\/[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/.test(m.run) ||
    typeof m.startedAt !== "string" ||
    !Number.isFinite(Date.parse(m.startedAt)) ||
    typeof m.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(m.finishedAt)) ||
    Date.parse(m.finishedAt) < Date.parse(m.startedAt) ||
    !Array.isArray(m.files) ||
    m.files.length !== expectedFiles(config).length
  )
    throw Error("Invalid backup manifest");
  const files = m.files.map(record);
  for (const name of expectedFiles(config)) {
    const matches = files.filter((f) => f.key === `${m.run}/${name}`);
    const f = matches[0];
    if (
      matches.length !== 1 ||
      !f ||
      typeof f.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      typeof f.bytes !== "number" ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes <= 0
    )
      throw Error("Invalid backup file record");
  }
  return value as Manifest;
}
export function validateIndex(value: unknown, config: BackupConfig): BackupIndex {
  const index = record(value);
  if (index.schema !== 1) throw Error("Unsupported backup index");
  const nightly = validateManifest(index.nightly, config);
  const weekly = validateManifest(index.weekly, config);
  if (
    index.week !== weekStart(new Date(weekly.startedAt), config.timeZone) ||
    Date.parse(nightly.startedAt) < Date.parse(weekly.startedAt)
  )
    throw Error("Invalid weekly boundary");
  return value as BackupIndex;
}
export function nextIndex(
  previous: BackupIndex | null,
  manifest: Manifest,
  config: BackupConfig,
): BackupIndex {
  validateManifest(manifest, config);
  if (previous) validateIndex(previous, config);
  const week = weekStart(new Date(manifest.startedAt), config.timeZone);
  if (previous && Date.parse(manifest.startedAt) <= Date.parse(previous.nightly.startedAt))
    throw Error("Refusing an older replacement");
  const promote = !previous || week > previous.week;
  return {
    schema: 1,
    week: promote ? week : previous.week,
    nightly: manifest,
    weekly: promote ? manifest : previous.weekly,
  };
}
export function obsoleteManifests(previous: BackupIndex | null, next: BackupIndex): Manifest[] {
  if (!previous) return [];
  const keep = new Set([next.nightly.run, next.weekly.run]);
  return [...new Map([previous.nightly, previous.weekly].map((m) => [m.run, m])).values()].filter(
    (m) => !keep.has(m.run),
  );
}
export function checkAge(index: BackupIndex, now = new Date()): void {
  const nightlyAge = now.getTime() - Date.parse(index.nightly.startedAt);
  const weeklyAge = now.getTime() - Date.parse(index.weekly.startedAt);
  if (nightlyAge < 0 || nightlyAge > 36 * 3600000)
    throw Error("Nightly backup is stale (>36 hours)");
  if (weeklyAge < 0 || weeklyAge > 8 * 86400000) throw Error("Weekly backup is stale (>8 days)");
}
