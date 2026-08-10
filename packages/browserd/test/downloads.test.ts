import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserDownloadStore } from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const firstDownloadId = "22222222-2222-4222-8222-222222222222";
const secondDownloadId = "33333333-3333-4333-8333-333333333333";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("BrowserDownloadStore", () => {
  test("settles one GUID-named file with exact integrity and no local path projection", async () => {
    const { store } = await fixture();
    const started = await store.begin({
      guid: "download-guid-1",
      targetId: "target-1",
      suggestedFilename: "report.txt",
    });
    expect(started).toMatchObject({
      id: firstDownloadId,
      status: "in_progress",
      filename: "report.txt",
      receivedBytes: 0,
    });
    await writeFile(join(store.filesDirectory, "download-guid-1"), "verified bytes");
    await expect(
      store.progress({
        guid: "download-guid-1",
        state: "completed",
        receivedBytes: 14,
        totalBytes: 14,
      }),
    ).resolves.toEqual({ cancelReason: null });

    const completed = (await store.list())[0]!;
    expect(completed).toMatchObject({
      status: "completed",
      receivedBytes: 14,
      totalBytes: 14,
      sha256: "186287b2d987891f027b4bc8baaf621a3e5a4a73ec78e04b0f65dc309b1ccc03",
    });
    expect(JSON.stringify(completed)).not.toContain(store.rootDirectory);
    expect(JSON.stringify(completed)).not.toContain("https://");
    expect(await readFile((await store.completedFile(completed.id)).path, "utf8")).toBe(
      "verified bytes",
    );
    await store.close();
  });

  test("recovers interrupted work as failed and removes orphaned bytes", async () => {
    const rootDirectory = await newRoot();
    const store = await BrowserDownloadStore.open({
      rootDirectory,
      browserSessionId,
      controllerGeneration,
      createId: () => firstDownloadId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    await store.begin({
      guid: "interrupted",
      targetId: null,
      suggestedFilename: "partial.bin",
    });
    await writeFile(join(store.filesDirectory, "interrupted.crdownload"), "partial");
    await store.close();

    const reopened = await BrowserDownloadStore.open({
      rootDirectory,
      browserSessionId,
      controllerGeneration,
      now: () => new Date("2026-08-10T12:01:00.000Z"),
    });
    expect((await reopened.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "controller_restarted",
      settledAt: "2026-08-10T12:01:00.000Z",
    });
    await expect(
      readFile(join(reopened.filesDirectory, "interrupted.crdownload")),
    ).rejects.toThrow();
    await reopened.close();
  });

  test("requests cancellation before a download can exceed its exact byte budget", async () => {
    const { store } = await fixture({ maxFileBytes: 10, maxSessionBytes: 20 });
    await store.begin({ guid: "large", targetId: null, suggestedFilename: "large.bin" });
    await expect(
      store.progress({
        guid: "large",
        state: "inProgress",
        receivedBytes: 11,
        totalBytes: 11,
      }),
    ).resolves.toEqual({ cancelReason: "download_quota_exceeded" });
    await store.reject("large", "download_quota_exceeded");
    expect((await store.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "download_quota_exceeded",
    });
    // Chromium can still report completion if cancellation lost its race. A
    // terminal failed resource must remove those late bytes, never resurrect.
    await writeFile(join(store.filesDirectory, "large"), "late browser bytes");
    await store.progress({
      guid: "large",
      state: "completed",
      receivedBytes: 18,
      totalBytes: 18,
    });
    await expect(readFile(join(store.filesDirectory, "large"))).rejects.toThrow();
    await store.close();
  });

  test("invalidates a completed resource if its controller-private bytes change", async () => {
    const { store } = await fixture();
    await store.begin({ guid: "changed", targetId: null, suggestedFilename: "changed.txt" });
    const path = join(store.filesDirectory, "changed");
    await writeFile(path, "first");
    await store.progress({
      guid: "changed",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
    });
    await chmod(path, 0o600);
    await writeFile(path, "other");
    await expect(store.completedFile(firstDownloadId)).rejects.toThrow("digest changed");
    expect(await store.get(firstDownloadId)).toMatchObject({
      status: "unavailable",
      failureCode: "download_storage_lost",
      sha256: null,
    });
    await store.close();
  });

  test("detects same-size corruption while recovering a completed resource", async () => {
    const rootDirectory = await newRoot();
    const store = await BrowserDownloadStore.open({
      rootDirectory,
      browserSessionId,
      controllerGeneration,
      createId: () => firstDownloadId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    await store.begin({ guid: "corrupt", targetId: null, suggestedFilename: "state.bin" });
    const path = join(store.filesDirectory, "corrupt");
    await writeFile(path, "first");
    await store.progress({
      guid: "corrupt",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
    });
    await store.close();

    await chmod(path, 0o600);
    await writeFile(path, "other");
    const reopened = await BrowserDownloadStore.open({
      rootDirectory,
      browserSessionId,
      controllerGeneration,
      now: () => new Date("2026-08-10T12:01:00.000Z"),
    });
    expect(await reopened.get(firstDownloadId)).toMatchObject({
      status: "unavailable",
      failureCode: "download_storage_lost",
      sha256: null,
    });
    await expect(readFile(path)).rejects.toThrow();
    await reopened.close();
  });

  test("binds each browser GUID once and sanitizes hostile display names", async () => {
    const { store } = await fixture();
    const started = await store.begin({
      guid: "bound",
      targetId: "target-1",
      suggestedFilename: "../bad\nname.txt",
    });
    expect(started.filename).toBe(".._bad_name.txt");
    await expect(
      store.begin({
        guid: "bound",
        targetId: "target-2",
        suggestedFilename: "different.txt",
      }),
    ).rejects.toThrow("already bound");
    await store.close();
  });
});

async function fixture(
  options: { maxFileBytes?: number; maxSessionBytes?: number } = {},
): Promise<{ store: BrowserDownloadStore }> {
  const ids = [firstDownloadId, secondDownloadId];
  const store = await BrowserDownloadStore.open({
    rootDirectory: await newRoot(),
    browserSessionId,
    controllerGeneration,
    createId: () => ids.shift()!,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    ...options,
  });
  return { store };
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/opengeni-browser-downloads-");
  roots.push(root);
  return root;
}
