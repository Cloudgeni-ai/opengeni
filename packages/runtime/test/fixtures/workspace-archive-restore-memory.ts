// Child process for workspace-archive-restore-memory.test.ts: restores one
// object-storage archive through the same two steps a cold restore takes (the
// worker's object fetch + inline, then the restore boundary's verified read)
// and prints how far the process's peak RSS rose above its level right before.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { workspaceArchiveObjectKey } from "@opengeni/contracts";
import {
  inlineWorkspaceArchiveForRestore,
  readVerifiedWorkspaceArchive,
} from "../../src/sandbox/workspace-archive";

function statusKiB(field: "VmRSS" | "VmHWM"): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(
    readFileSync("/proc/self/status", "utf8"),
  );
  if (!match) throw new Error(`/proc/self/status has no ${field}`);
  return Number(match[1]);
}

const archiveBytes = Number(process.argv[2]);
// Object storage clients hand back Node Buffers.
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
const key = workspaceArchiveObjectKey({
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sandboxGroupId: "33333333-3333-4333-8333-333333333333",
  revision,
});
const ref = {
  schema: "sandbox_archive_object_v1" as const,
  key,
  sha256,
  bytes: archive.length,
  backend: "s3-compatible",
};

Bun.gc(true);
const baselineKiB = statusKiB("VmRSS");
const startedAt = performance.now();
const sessionState = await inlineWorkspaceArchiveForRestore(
  { workspaceArchiveRef: ref, workspaceArchiveMeta: descriptor },
  async () => ({ bytes: archive }),
);
const verified = readVerifiedWorkspaceArchive(
  sessionState.workspaceArchive,
  sessionState.workspaceArchiveMeta,
);
if (!verified || verified.bytes.length !== archive.length) {
  throw new Error("restore did not return the archive bytes");
}
console.log(
  JSON.stringify({
    peakGrowthBytes: (statusKiB("VmHWM") - baselineKiB) * 1024,
    elapsedMs: Math.round(performance.now() - startedAt),
  }),
);
