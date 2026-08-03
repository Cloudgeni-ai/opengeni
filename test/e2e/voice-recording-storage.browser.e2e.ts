import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("durable voice recording browser storage", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: ReturnType<typeof Bun.serve>;
  let moduleSource: string;
  let ownerModuleSource: string;
  let page: Page;

  beforeAll(async () => {
    const [build, ownerBuild] = await Promise.all([
      Bun.build({
        entrypoints: [`${repoRoot}/packages/react/src/voice-recording-store.ts`],
        format: "esm",
        target: "browser",
        write: false,
      }),
      Bun.build({
        entrypoints: [`${repoRoot}/packages/react/src/voice-recording-owner.ts`],
        format: "esm",
        target: "browser",
        write: false,
      }),
    ]);
    if (!build.success || !build.outputs[0]) {
      throw new Error(`Voice recording store build failed: ${build.logs.join("\n")}`);
    }
    if (!ownerBuild.success || !ownerBuild.outputs[0]) {
      throw new Error(`Voice recording owner build failed: ${ownerBuild.logs.join("\n")}`);
    }
    moduleSource = await build.outputs[0].text();
    ownerModuleSource = await ownerBuild.outputs[0].text();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><html><body>voice storage test</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    const configuredChromium =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.OPENGENI_BROWSER_BIN;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close()]);
    server?.stop(true);
  });

  test("survives close and reload, deduplicates exact audio, and discards intentionally", async () => {
    const databaseName = `opengeni-voice-test-${crypto.randomUUID()}`;
    const recordingId = crypto.randomUUID();
    const initial = await page.evaluate(
      async ({
        source,
        databaseName: requestedDatabaseName,
        recordingId: requestedRecordingId,
      }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const storage = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-store");
        URL.revokeObjectURL(moduleUrl);
        const store = new storage.IndexedDbVoiceRecordingStore({
          databaseName: requestedDatabaseName,
        });
        const manifest = storage.createVoiceRecordingManifest({
          recordingId: requestedRecordingId,
          workspaceId: "workspace-1",
          mimeType: "audio/webm;codecs=opus",
          createdAt: "2026-08-03T21:00:00.000Z",
        });
        await store.createManifest(manifest);
        const persisted = await store.persistChunk({
          recordingId: requestedRecordingId,
          chunkNumber: 0,
          capturedAt: "2026-08-03T21:00:05.000Z",
          startMilliseconds: 0,
          durationMilliseconds: 5_000,
          mimeType: manifest.mimeType,
          audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: manifest.mimeType }),
        });
        await store.close();
        return {
          sha256: persisted.chunk.sha256,
          chunkCount: persisted.manifest.chunkCount,
          totalBytes: persisted.manifest.totalBytes,
        };
      },
      { source: moduleSource, databaseName, recordingId },
    );

    expect(initial).toMatchObject({ chunkCount: 1, totalBytes: 4 });
    expect(initial.sha256).toMatch(/^[a-f0-9]{64}$/u);

    await page.reload();

    const recovered = await page.evaluate(
      async ({
        source,
        databaseName: requestedDatabaseName,
        recordingId: requestedRecordingId,
      }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const storage = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-store");
        URL.revokeObjectURL(moduleUrl);
        const store = new storage.IndexedDbVoiceRecordingStore({
          databaseName: requestedDatabaseName,
        });
        const manifests = await store.listRecoverableManifests("workspace-1");
        const chunks = await store.listChunks(requestedRecordingId);
        const duplicate = await store.persistChunk({
          recordingId: requestedRecordingId,
          chunkNumber: 0,
          capturedAt: "2026-08-03T21:00:05.000Z",
          startMilliseconds: 0,
          durationMilliseconds: 5_000,
          mimeType: "audio/webm;codecs=opus",
          audio: new Blob([new Uint8Array([1, 2, 3, 4])], {
            type: "audio/webm;codecs=opus",
          }),
        });
        let conflictName: string | null = null;
        try {
          await store.persistChunk({
            recordingId: requestedRecordingId,
            chunkNumber: 0,
            capturedAt: "2026-08-03T21:00:05.000Z",
            startMilliseconds: 0,
            durationMilliseconds: 5_000,
            mimeType: "audio/webm;codecs=opus",
            audio: new Blob([new Uint8Array([9, 9, 9, 9])], {
              type: "audio/webm;codecs=opus",
            }),
          });
        } catch (error) {
          conflictName = error instanceof Error ? error.name : "unknown";
        }
        await store.discard(requestedRecordingId);
        const afterDiscard = await store.listRecoverableManifests("workspace-1");
        await store.close();
        await new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase(requestedDatabaseName);
          deletion.onsuccess = () => resolve();
          deletion.onerror = () => reject(deletion.error);
          deletion.onblocked = () => reject(new Error("Test database deletion was blocked."));
        });
        return {
          manifestCount: manifests.length,
          chunkCount: chunks.length,
          recoveredBytes: chunks[0]?.byteLength ?? 0,
          deduplicated: duplicate.deduplicated,
          duplicateManifestChunkCount: duplicate.manifest.chunkCount,
          conflictName,
          afterDiscardCount: afterDiscard.length,
        };
      },
      { source: moduleSource, databaseName, recordingId },
    );

    expect(recovered).toEqual({
      manifestCount: 1,
      chunkCount: 1,
      recoveredBytes: 4,
      deduplicated: true,
      duplicateManifestChunkCount: 1,
      conflictName: "VoiceRecordingChunkConflictError",
      afterDiscardCount: 0,
    });
  }, 30_000);

  test("blocks a second live owner and permits only explicit stale takeover", async () => {
    const databaseName = `opengeni-voice-owner-test-${crypto.randomUUID()}`;
    const result = await page.evaluate(
      async ({ source, databaseName: requestedDatabaseName }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const storage = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-store");
        URL.revokeObjectURL(moduleUrl);
        const ownerStore = new storage.IndexedDbVoiceRecordingStore({
          databaseName: requestedDatabaseName,
        });
        const otherStore = new storage.IndexedDbVoiceRecordingStore({
          databaseName: requestedDatabaseName,
        });
        const manifest = storage.createVoiceRecordingManifest({
          recordingId: "live-recording",
          workspaceId: "workspace-1",
          mimeType: "audio/webm",
          createdAt: "2026-08-03T21:00:00.000Z",
          ownerId: "tab-a",
        });
        await ownerStore.createManifest(manifest);
        const hiddenFromOtherOwner = await otherStore.listRecoverableManifests("workspace-1", {
          ownerId: "tab-b",
          staleBefore: "2026-08-03T20:59:30.000Z",
        });
        let liveClaimError: string | null = null;
        try {
          await otherStore.claimManifest(
            manifest.recordingId,
            "tab-b",
            "2026-08-03T21:00:05.000Z",
            "2026-08-03T20:59:30.000Z",
          );
        } catch (error) {
          liveClaimError = error instanceof Error ? error.name : "unknown";
        }
        let liveDiscardError: string | null = null;
        try {
          await otherStore.discard(manifest.recordingId, "tab-b");
        } catch (error) {
          liveDiscardError = error instanceof Error ? error.name : "unknown";
        }
        const staleClaim = await otherStore.claimManifest(
          manifest.recordingId,
          "tab-b",
          "2026-08-03T21:01:00.000Z",
          "2026-08-03T21:00:30.000Z",
        );
        await otherStore.discard(manifest.recordingId, "tab-b");
        await Promise.all([ownerStore.close(), otherStore.close()]);
        await new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase(requestedDatabaseName);
          deletion.onsuccess = () => resolve();
          deletion.onerror = () => reject(deletion.error);
          deletion.onblocked = () => reject(new Error("Test database deletion was blocked."));
        });
        return {
          hiddenCount: hiddenFromOtherOwner.length,
          liveClaimError,
          liveDiscardError,
          staleClaimOwner: staleClaim.ownerId,
          staleClaimCaptureState: staleClaim.captureState,
        };
      },
      { source: moduleSource, databaseName },
    );

    expect(result).toEqual({
      hiddenCount: 0,
      liveClaimError: "VoiceRecordingOwnedError",
      liveDiscardError: "VoiceRecordingOwnedError",
      staleClaimOwner: "tab-b",
      staleClaimCaptureState: "stopped",
    });
  }, 30_000);

  test("garbage-collects only owner-safe handed-off records and their chunks", async () => {
    const databaseName = `opengeni-voice-cleanup-test-${crypto.randomUUID()}`;
    const result = await page.evaluate(
      async ({ source, databaseName: requestedDatabaseName }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const storage = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-store");
        URL.revokeObjectURL(moduleUrl);
        const store = new storage.IndexedDbVoiceRecordingStore({
          databaseName: requestedDatabaseName,
        });
        const records = [
          {
            recordingId: "handed-off-current",
            ownerId: "tab-current",
            createdAt: "2026-08-03T21:00:00.000Z",
            capturedAt: "2026-08-03T21:00:05.000Z",
          },
          {
            recordingId: "handed-off-other-live",
            ownerId: "tab-other",
            createdAt: "2026-08-03T21:00:10.000Z",
            capturedAt: "2026-08-03T21:00:20.000Z",
          },
          {
            recordingId: "handed-off-stale",
            ownerId: "tab-stale",
            createdAt: "2026-08-03T20:00:00.000Z",
            capturedAt: "2026-08-03T20:00:05.000Z",
          },
        ] as const;
        for (const record of records) {
          const manifest = storage.createVoiceRecordingManifest({
            recordingId: record.recordingId,
            workspaceId: "workspace-1",
            mimeType: "audio/webm",
            createdAt: record.createdAt,
            ownerId: record.ownerId,
          });
          await store.createManifest(manifest);
          await store.persistChunk({
            recordingId: record.recordingId,
            ownerId: record.ownerId,
            chunkNumber: 0,
            capturedAt: record.capturedAt,
            startMilliseconds: 0,
            durationMilliseconds: 1_000,
            mimeType: manifest.mimeType,
            audio: new Blob([record.recordingId], { type: manifest.mimeType }),
          });
          await store.updateManifest(
            record.recordingId,
            { finalizationState: "handed-off", transcriptText: `text:${record.recordingId}` },
            record.capturedAt,
            record.ownerId,
          );
        }

        const firstDeleted = await store.cleanupHandedOffManifests({
          ownerId: "tab-current",
          staleBefore: "2026-08-03T20:59:30.000Z",
        });
        const afterFirst = await Promise.all(
          records.map(async (record) => ({
            recordingId: record.recordingId,
            manifest: await store.getManifest(record.recordingId),
            chunks: await store.listChunks(record.recordingId),
          })),
        );
        const secondDeleted = await store.cleanupHandedOffManifests({
          ownerId: "tab-current",
          staleBefore: "2026-08-03T21:00:30.000Z",
        });
        const remaining = await store.getManifest("handed-off-other-live");
        await store.close();
        await new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase(requestedDatabaseName);
          deletion.onsuccess = () => resolve();
          deletion.onerror = () => reject(deletion.error);
          deletion.onblocked = () => reject(new Error("Test database deletion was blocked."));
        });
        return {
          firstDeleted,
          secondDeleted,
          afterFirst: afterFirst.map((record) => ({
            recordingId: record.recordingId,
            hasManifest: record.manifest !== null,
            chunkCount: record.chunks.length,
          })),
          remaining: remaining !== null,
        };
      },
      { source: moduleSource, databaseName },
    );

    expect(result).toEqual({
      firstDeleted: 2,
      secondDeleted: 1,
      afterFirst: [
        { recordingId: "handed-off-current", hasManifest: false, chunkCount: 0 },
        { recordingId: "handed-off-other-live", hasManifest: true, chunkCount: 1 },
        { recordingId: "handed-off-stale", hasManifest: false, chunkCount: 0 },
      ],
      remaining: false,
    });
  }, 30_000);

  test("rotates copied opener ownership while preserving reload reuse", async () => {
    const sessionKey = "opengeni.voice-recording-owner.v1";
    const opener = await page.evaluate(
      async ({ source, key }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const owner = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-owner");
        URL.revokeObjectURL(moduleUrl);
        const lease = await owner.acquireDefaultVoiceRecordingOwnerLease();
        (
          window as typeof window & {
            __voiceRecordingOwnerLease?: { ownerId: string; release: () => void };
          }
        ).__voiceRecordingOwnerLease = lease;
        return {
          ownerId: lease.ownerId,
          storedOwnerId: sessionStorage.getItem(key),
        };
      },
      { source: ownerModuleSource, key: sessionKey },
    );

    const childPromise = context.waitForEvent("page");
    await page.evaluate(() => {
      window.open(`${location.origin}/child`, "_blank");
    });
    const child = await childPromise;
    await child.waitForLoadState("domcontentloaded");
    const copiedBeforeAcquisition = await child.evaluate(
      (key) => sessionStorage.getItem(key),
      sessionKey,
    );
    const childOwner = await child.evaluate(
      async ({ source, key }) => {
        const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const owner = (await import(
          moduleUrl
        )) as typeof import("../../packages/react/src/voice-recording-owner");
        URL.revokeObjectURL(moduleUrl);
        const lease = await owner.acquireDefaultVoiceRecordingOwnerLease();
        (
          window as typeof window & {
            __voiceRecordingOwnerLease?: { ownerId: string; release: () => void };
          }
        ).__voiceRecordingOwnerLease = lease;
        return {
          ownerId: lease.ownerId,
          storedOwnerId: sessionStorage.getItem(key),
        };
      },
      { source: ownerModuleSource, key: sessionKey },
    );

    expect(opener.storedOwnerId).toBe(opener.ownerId);
    expect(copiedBeforeAcquisition).toBe(opener.ownerId);
    expect(childOwner.ownerId).not.toBe(opener.ownerId);
    expect(childOwner.storedOwnerId).toBe(childOwner.ownerId);

    await child.evaluate(() => {
      (
        window as typeof window & {
          __voiceRecordingOwnerLease?: { release: () => void };
        }
      ).__voiceRecordingOwnerLease?.release();
    });
    await child.close();

    // Reload while the old document still holds its lease. Browser teardown
    // releases that lock, and the new document must retain the same tab owner.
    await page.reload();
    const reloadedOwner = await page.evaluate(async (source) => {
      const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const owner = (await import(
        moduleUrl
      )) as typeof import("../../packages/react/src/voice-recording-owner");
      URL.revokeObjectURL(moduleUrl);
      const lease = await owner.acquireDefaultVoiceRecordingOwnerLease();
      lease.release();
      return lease.ownerId;
    }, ownerModuleSource);
    expect(reloadedOwner).toBe(opener.ownerId);
  }, 30_000);
});
