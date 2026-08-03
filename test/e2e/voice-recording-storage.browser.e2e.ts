import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("durable voice recording browser storage", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let moduleSource: string;
  let page: Page;

  beforeAll(async () => {
    const build = await Bun.build({
      entrypoints: [`${repoRoot}/packages/react/src/voice-recording-store.ts`],
      format: "esm",
      target: "browser",
      write: false,
    });
    if (!build.success || !build.outputs[0]) {
      throw new Error(`Voice recording store build failed: ${build.logs.join("\n")}`);
    }
    moduleSource = await build.outputs[0].text();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><html><body>voice storage test</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    const context = await browser.newContext();
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
});
