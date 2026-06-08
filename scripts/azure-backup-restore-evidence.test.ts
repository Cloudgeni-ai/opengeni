import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./azure-backup-restore-evidence.ts", import.meta.url).pathname;

describe("Azure backup restore evidence", () => {
  it("passes with backup metadata and successful restore evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-backup-"));
    const backups = join(dir, "backups.json");
    const restore = join(dir, "restore.json");
    const out = join(dir, "backup-restore.json");
    writeFileSync(backups, JSON.stringify([{ completedTime: new Date().toISOString(), backupType: "Full", source: "Automatic" }]));
    writeFileSync(restore, JSON.stringify({
      restoreDrillCompleted: true,
      restoredDatabaseValidated: true,
      restoredObjectStorageValidated: true,
    }));

    const result = runScript(backups, out, ["--restore-evidence", restore]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks[0].metrics.backupPolicyEnabled).toBe(true);
  });

  it("uses validated restore time as RPO source for PITR backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-backup-"));
    const backups = join(dir, "backups.json");
    const restore = join(dir, "restore.json");
    const out = join(dir, "backup-restore.json");
    writeFileSync(backups, JSON.stringify([{
      completedTime: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      backupType: "Full",
      source: "Automatic",
    }]));
    writeFileSync(restore, JSON.stringify({
      restoreDrillCompleted: true,
      restoredDatabaseValidated: true,
      restoredObjectStorageValidated: true,
      restoreTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    }));

    const result = runScript(backups, out, ["--restore-evidence", restore, "--max-rpo-seconds", "3600"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].metrics.rpoSource).toBe("restoreTime");
  });

  it("fails closed when restore evidence is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-backup-"));
    const backups = join(dir, "backups.json");
    const out = join(dir, "backup-restore.json");
    writeFileSync(backups, JSON.stringify([{ completedTime: new Date().toISOString(), backupType: "Full", source: "Automatic" }]));

    const result = runScript(backups, out);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(false);
    expect(payload.checks[0].metrics.restoreDrillCompleted).toBe(false);
  });
});

function runScript(backups: string, out: string, extra: string[] = []): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [
    scriptPath,
    "--backups", backups,
    "--out", out,
    "--max-rpo-seconds", "86400",
    ...extra,
  ], { encoding: "utf8" });
}
