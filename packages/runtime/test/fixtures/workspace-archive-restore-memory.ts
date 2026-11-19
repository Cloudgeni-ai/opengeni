// Child process for workspace-archive-restore-memory.test.ts: reads one inline
// (database) archive through the restore boundary's verified read and prints
// how far the process's peak RSS rose above its level right before.
// Object-storage archives never reach this path: cold restore streams them
// from a verified disk spool (workspace-archive-stream-memory.test.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readVerifiedWorkspaceArchive } from "../../src/sandbox/workspace-archive";

function statusKiB(field: "VmRSS" | "VmHWM"): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(
    readFileSync("/proc/self/status", "utf8"),
  );
  if (!match) throw new Error(`/proc/self/status has no ${field}`);
  return Number(match[1]);
}

const archiveBytes = Number(process.argv[2]);
const archive = Buffer.alloc(archiveBytes);
for (let offset = 0; offset < archive.length; offset += 4096) {
  archive.writeUInt32LE(offset, offset);
}
const sha256 = createHash("sha256").update(archive).digest("hex");
const capturedAt = Date.UTC(2026, 0, 1);
const revision = `wa1:${String(capturedAt).padStart(13, "0")}:${sha256}`;
const descriptor = {
  version: 1 as const,
  revision,
  archiveSha256: sha256,
  archiveBytes: archive.length,
  capturedAt: new Date(capturedAt).toISOString(),
  workspace: {
    algorithm: "sha256" as const,
    sha256,
    entryCount: 1,
    fileCount: 1,
    totalFileBytes: archive.length,
  },
};
// The session state holds the archive as base64, as an inline save stores it.
const workspaceArchive = archive.toString("base64");

Bun.gc(true);
const baselineKiB = statusKiB("VmRSS");
const startedAt = performance.now();
const verified = readVerifiedWorkspaceArchive(workspaceArchive, descriptor);
if (!verified || verified.bytes.length !== archive.length) {
  throw new Error("restore did not return the archive bytes");
}
console.log(
  JSON.stringify({
    peakGrowthBytes: (statusKiB("VmHWM") - baselineKiB) * 1024,
    elapsedMs: Math.round(performance.now() - startedAt),
  }),
);
