import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspaceArchiveForStorage,
  disposeWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  terminateManagedSandboxSession,
} from "@opengeni/runtime/sandbox";
import { downloadWorkspaceArchiveSpool, type ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing";
import { putVersion1TarArchiveOrInline } from "../src/sandbox-archive-storage";

const large = process.env.OPENGENI_TEST_LARGE_WORKSPACE_ARCHIVE === "1";

test.skipIf(process.platform !== "linux")(
  "disk-backed capture, object publication, cold restore, and verification retain every byte",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-archive-roundtrip-"));
    const objectPath = join(root, "stored-object");
    const settings = testSettings({ sandboxBackend: "local" });
    const created = await establishSandboxSessionFromEnvelope(settings, null, {
      sessionId: "archive-spool-source",
      recovery: "create-or-restore",
      backendOverride: "local",
      environment: {},
    });
    const sourceRoot = (created.session as { state: { workspaceRootPath: string } }).state
      .workspaceRootPath;
    let restored: Awaited<ReturnType<typeof establishSandboxSessionFromEnvelope>> | undefined;
    let archive: Awaited<ReturnType<typeof captureWorkspaceArchiveForStorage>> | undefined;
    const memberBytes = large ? 512 * 1024 * 1024 : 512 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const expectedHash = createHash("sha256");
    let storedBytes = 0;
    const memoryStart = process.memoryUsage();
    let peakRss = memoryStart.rss;
    let peakHeap = memoryStart.heapUsed;
    let peakHeapCapacity = memoryStart.heapTotal;
    let phase = "fixture";
    const phasePeaks = new Map<
      string,
      { rss: number; heapUsed: number; external: number; arrayBuffers: number }
    >();
    const sample = setInterval(() => {
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakHeap = Math.max(peakHeap, usage.heapUsed);
      peakHeapCapacity = Math.max(peakHeapCapacity, usage.heapTotal);
      const prior = phasePeaks.get(phase);
      phasePeaks.set(phase, {
        rss: Math.max(prior?.rss ?? 0, usage.rss),
        heapUsed: Math.max(prior?.heapUsed ?? 0, usage.heapUsed),
        external: Math.max(prior?.external ?? 0, usage.external),
        arrayBuffers: Math.max(prior?.arrayBuffers ?? 0, usage.arrayBuffers),
      });
    }, 100);
    const storage = {
      backend: "s3-compatible",
      async putObjectStream(input: { chunks: AsyncIterable<Uint8Array>; byteSize: number }) {
        const handle = await open(objectPath, "wx");
        try {
          for await (const bytes of input.chunks) {
            let offset = 0;
            while (offset < bytes.length) {
              const result = await handle.write(bytes, offset, bytes.length - offset);
              if (!result.bytesWritten) throw new Error("fixture write made no progress");
              offset += result.bytesWritten;
              storedBytes += result.bytesWritten;
            }
          }
        } finally {
          await handle.close();
        }
        expect(storedBytes).toBe(input.byteSize);
      },
      async headObject() {
        return { ContentLength: (await stat(objectPath)).size, VersionToken: "fixture-version-1" };
      },
      async getObjectRange(input: {
        start: number;
        endInclusive: number;
        expectedVersionToken: string;
      }) {
        expect(input.expectedVersionToken).toBe("fixture-version-1");
        const bytes = Buffer.alloc(input.endInclusive - input.start + 1);
        const handle = await open(objectPath, "r");
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const result = await handle.read(
              bytes,
              offset,
              bytes.length - offset,
              input.start + offset,
            );
            if (!result.bytesRead) throw new Error("fixture range truncated");
            offset += result.bytesRead;
          }
        } finally {
          await handle.close();
        }
        return { bytes, versionToken: "fixture-version-1" };
      },
      async getObjectBytes(): Promise<never> {
        throw new Error("whole-object download forbidden");
      },
      async putObject(): Promise<never> {
        throw new Error("whole-object upload forbidden");
      },
    } as unknown as ObjectStorage;
    try {
      for (let member = 0; member < 3; member += 1) {
        const handle = await open(join(sourceRoot, `member-${member}.bin`), "wx");
        try {
          for (let offset = 0; offset < memberBytes; offset += chunk.length) {
            let written = 0;
            while (written < chunk.length) {
              const result = await handle.write(chunk, written, chunk.length - written);
              if (!result.bytesWritten) throw new Error("fixture write made no progress");
              written += result.bytesWritten;
            }
            if (member === 0) expectedHash.update(chunk);
          }
        } finally {
          await handle.close();
        }
      }
      await writeFile(join(sourceRoot, "note.txt"), "Retain all source files.\n");
      phase = "capture";
      archive = await captureWorkspaceArchiveForStorage(
        created.session,
        1_900_000_000_000,
        { requestId: "11111111-1111-4111-8111-111111111111" },
        true,
      );
      expect(archive.kind).toBe("host_spool");
      expect("base64" in archive).toBe(false);
      expect("bytes" in archive).toBe(false);
      phase = "upload";
      const published = await putVersion1TarArchiveOrInline({
        backend: "local",
        objectStorage: storage,
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        archive,
      });
      expect(published.workspaceArchive).toBeUndefined();
      phase = "restore";
      restored = await establishSandboxSessionFromEnvelope(
        settings,
        {
          backendId: "local",
          sessionState: { ...published, workspaceArchiveMeta: archive.descriptor },
        },
        {
          sessionId: "archive-spool-restored",
          recovery: "create-or-restore",
          backendOverride: "local",
          environment: {},
          loadHostWorkspaceArchive: (ref) =>
            downloadWorkspaceArchiveSpool(storage, ref.key, {
              bytes: ref.bytes,
              sha256: ref.sha256,
            }),
        },
      );
      expect(restored.origin).toBe("restored");
      const destination = (restored.session as { state: { workspaceRootPath: string } }).state
        .workspaceRootPath;
      phase = "test-verification";
      const expectedDigest = expectedHash.digest("hex");
      for (let member = 0; member < 3; member += 1) {
        const handle = await open(join(destination, `member-${member}.bin`), "r");
        const digest = createHash("sha256");
        try {
          expect((await handle.stat()).size).toBe(memberBytes);
          for await (const bytes of handle.readableWebStream())
            digest.update(new Uint8Array(bytes));
        } finally {
          await handle.close().catch(() => undefined);
        }
        expect(digest.digest("hex")).toBe(expectedDigest);
      }
      expect(await readFile(join(destination, "note.txt"), "utf8")).toBe(
        "Retain all source files.\n",
      );
      if (large) {
        console.info("large archive roundtrip memory", {
          sourceBytes: 3 * memberBytes,
          storedBytes,
          peakRss,
          peakHeap,
          peakHeapCapacity,
          rssGrowth: peakRss - memoryStart.rss,
          phasePeaks: Object.fromEntries(phasePeaks),
        });
        // Bun's heapUsed includes external payload allocations awaiting GC and
        // can exceed both heapTotal and RSS. Do not force GC or reuse chunks
        // whose consumers may retain them merely to reduce that counter.
        // Keep the raw capture budget (which caught codec allocation churn),
        // and bound VM heap capacity plus total resident memory end-to-end.
        expect(phasePeaks.get("capture")!.heapUsed - memoryStart.heapUsed).toBeLessThan(
          256 * 1024 * 1024,
        );
        expect(peakHeapCapacity - memoryStart.heapTotal).toBeLessThan(256 * 1024 * 1024);
        expect(peakRss - memoryStart.rss).toBeLessThan(768 * 1024 * 1024);
      }
    } finally {
      clearInterval(sample);
      await disposeWorkspaceArchive(archive);
      if (restored)
        await terminateManagedSandboxSession(
          restored.client,
          restored.sessionState,
          restored.session,
        );
      await terminateManagedSandboxSession(created.client, created.sessionState, created.session);
      await rm(root, { recursive: true, force: true });
    }
  },
  large ? 1_800_000 : 30_000,
);
