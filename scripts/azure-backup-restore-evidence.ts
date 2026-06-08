import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

interface Args {
  backupsFile: string;
  restoreEvidenceFile: string | null;
  outFile: string;
  maxRpoSeconds: number;
}

const args = parseArgs(process.argv.slice(2), process.env);
const backups = parseBackups(args.backupsFile);
const latestBackup = backups
  .map((backup) => ({ ...backup, completedAtMs: backup.completedTime ? Date.parse(backup.completedTime) : Number.NaN }))
  .filter((backup) => Number.isFinite(backup.completedAtMs))
  .sort((a, b) => b.completedAtMs - a.completedAtMs)[0] ?? null;
const restoreEvidence = args.restoreEvidenceFile ? parseRestoreEvidence(args.restoreEvidenceFile) : null;
const restoreTimeMs = timestampField(restoreEvidence, "restoreTime");
const rpoSourceTimeMs = restoreTimeMs ?? latestBackup?.completedAtMs ?? Number.NaN;
const rpoSeconds = Number.isFinite(rpoSourceTimeMs)
  ? Math.max(0, Math.round((Date.now() - rpoSourceTimeMs) / 1000))
  : Number.POSITIVE_INFINITY;
const metrics = {
  backupPolicyEnabled: backups.length > 0,
  latestBackupCompletedAt: latestBackup?.completedTime ?? null,
  latestBackupType: latestBackup?.backupType ?? null,
  latestBackupSource: latestBackup?.source ?? null,
  rpoSource: restoreTimeMs ? "restoreTime" : "latestBackupCompletedAt",
  rpoSeconds,
  restoreDrillCompleted: restoreEvidence?.restoreDrillCompleted === true,
  restoredDatabaseValidated: restoreEvidence?.restoredDatabaseValidated === true,
  restoredObjectStorageValidated: restoreEvidence?.restoredObjectStorageValidated === true,
};
const ok = metrics.backupPolicyEnabled
  && metrics.rpoSeconds <= args.maxRpoSeconds
  && metrics.restoreDrillCompleted
  && metrics.restoredDatabaseValidated
  && metrics.restoredObjectStorageValidated;

const output = {
  ok,
  checks: [{
    id: "backup-restore",
    status: ok ? "passed" : "failed",
    detail: ok
      ? `backup and restore drill validated with rpoSeconds=${metrics.rpoSeconds}`
      : "backup metadata exists only if present; restore drill validation is incomplete",
    evidence: [args.backupsFile, ...(args.restoreEvidenceFile ? [args.restoreEvidenceFile] : [])],
    metrics,
  }],
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

function parseBackups(path: string): Array<Record<string, any>> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Azure backup list evidence must be an array");
  }
  return parsed.map((backup) => {
    if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
      throw new Error("Azure backup entry must be an object");
    }
    return backup as Record<string, any>;
  });
}

function parseRestoreEvidence(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`restore evidence file does not exist: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("restore evidence must be an object");
  }
  return parsed as Record<string, unknown>;
}

function timestampField(record: Record<string, unknown> | null, field: string): number | null {
  const value = record?.[field];
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    backupsFile: env.OPENGENI_AZURE_BACKUPS_FILE ?? "",
    restoreEvidenceFile: env.OPENGENI_RESTORE_EVIDENCE_FILE ?? null,
    outFile: env.OPENGENI_BACKUP_RESTORE_OUT_FILE ?? ".agent/generated/staging/backup-restore.json",
    maxRpoSeconds: Number(env.OPENGENI_BACKUP_RESTORE_MAX_RPO_SECONDS ?? 3_600),
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--backups") {
      out.backupsFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--restore-evidence") {
      out.restoreEvidenceFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--max-rpo-seconds") {
      out.maxRpoSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.backupsFile) {
    throw new Error("Set --backups or OPENGENI_AZURE_BACKUPS_FILE");
  }
  if (!Number.isFinite(out.maxRpoSeconds) || out.maxRpoSeconds <= 0) {
    throw new Error("--max-rpo-seconds must be positive");
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
