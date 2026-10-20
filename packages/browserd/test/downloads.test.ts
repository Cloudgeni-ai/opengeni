import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BrowserDownloadStore, chromiumCopyNumber } from "../src";

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

  test("follows the file Chromium names and keeps it across a restart", async () => {
    const rootDirectory = await newRoot();
    const open = async () =>
      await BrowserDownloadStore.open({
        rootDirectory,
        browserSessionId,
        controllerGeneration,
        createId: () => firstDownloadId,
      });
    const store = await open();
    await store.begin({ guid: "named-guid", targetId: null, suggestedFilename: "report.pdf" });
    // Chromium saved it under a name of its own choosing, beside an earlier
    // file with the same suggested name.
    const path = join(store.filesDirectory, "report (1).pdf");
    await writeFile(path, "%PDF bytes");
    await store.progress({
      guid: "named-guid",
      state: "completed",
      receivedBytes: 10,
      totalBytes: 10,
      filePath: path,
    });
    expect((await store.completedFile(firstDownloadId)).path).toBe(path);
    expect((await store.get(firstDownloadId))?.filename).toBe("report.pdf");
    await store.close();
    // An orphan Chromium left behind is swept; the named file is retained.
    await writeFile(join(rootDirectory, "files", "stray.pdf.crdownload"), "partial");
    const reopened = await open();
    expect(await readFile((await reopened.completedFile(firstDownloadId)).path, "utf8")).toBe(
      "%PDF bytes",
    );
    await expect(readFile(join(reopened.filesDirectory, "stray.pdf.crdownload"))).rejects.toThrow();
    await reopened.close();
  });

  test("removes a named file that completed over its quota", async () => {
    const { store } = await fixture({ maxFileBytes: 5, maxSessionBytes: 20 });
    await store.begin({ guid: "over", targetId: null, suggestedFilename: "large.bin" });
    const path = join(store.filesDirectory, "large.bin");
    await writeFile(path, "ten bytes!");
    await expect(
      store.progress({
        guid: "over",
        state: "completed",
        receivedBytes: 10,
        totalBytes: 10,
        filePath: path,
      }),
    ).resolves.toEqual({ cancelReason: "download_quota_exceeded" });
    await store.reject("over", "download_quota_exceeded");
    expect((await store.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "download_quota_exceeded",
    });
    await expect(readFile(path)).rejects.toThrow();
    await store.close();
  });

  test("finds the file Chromium named when the page reports no path", async () => {
    const { store } = await fixture();
    // An earlier download already owns "report.pdf".
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.pdf" });
    await writeFile(join(store.filesDirectory, "report.pdf"), "first");
    await store.progress({ guid: "first", state: "completed", receivedBytes: 5, totalBytes: 5 });
    await store.begin({ guid: "second", targetId: "t", suggestedFilename: "report.pdf" });
    await writeFile(join(store.filesDirectory, "report (1).pdf"), "second!");
    await writeFile(join(store.filesDirectory, "report (2).pdf.crdownload"), "partial");
    await store.progress({ guid: "second", state: "completed", receivedBytes: 7, totalBytes: 7 });
    const [second, first] = await store.list();
    expect(first).toMatchObject({ status: "completed", receivedBytes: 5 });
    expect(second).toMatchObject({ status: "completed", receivedBytes: 7 });
    expect(basename((await store.completedFile(first!.id)).path)).toBe("report.pdf");
    expect(basename((await store.completedFile(second!.id)).path)).toBe("report (1).pdf");
    await store.close();
  });

  test("fails a page-reported completion whose file cannot be found", async () => {
    const { store } = await fixture();
    await store.begin({ guid: "lost", targetId: null, suggestedFilename: "lost.txt" });
    await store.progress({ guid: "lost", state: "completed", receivedBytes: 4, totalBytes: 4 });
    expect((await store.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    await store.close();
  });

  test("settles a cancellation that reports no bytes", async () => {
    const { store } = await fixture();
    await store.begin({ guid: "stop", targetId: null, suggestedFilename: "big.bin" });
    await store.progress({
      guid: "stop",
      state: "inProgress",
      receivedBytes: 40,
      totalBytes: null,
    });
    await store.progress({ guid: "stop", state: "canceled", receivedBytes: 0, totalBytes: 0 });
    expect((await store.list())[0]).toMatchObject({ status: "cancelled" });
    await store.close();
  });

  test("follows a download whose page closed until Chromium names its file", async () => {
    const { store } = await fixture();
    await store.begin({ guid: "popup", targetId: "closed", suggestedFilename: "Popup report.pdf" });
    const cancelled: string[] = [];
    store.followUnreported("popup", async (reason) => {
      cancelled.push(reason);
    });
    await writeFile(join(store.filesDirectory, "Popup report.pdf.crdownload"), "%PDF");
    await Bun.sleep(250);
    expect((await store.list())[0]).toMatchObject({ status: "in_progress", receivedBytes: 4 });
    await rename(
      join(store.filesDirectory, "Popup report.pdf.crdownload"),
      join(store.filesDirectory, "Popup report.pdf"),
    );
    const settled = await settledDownload(store);
    expect(settled).toMatchObject({ status: "completed", receivedBytes: 4 });
    expect(basename((await store.completedFile(settled.id)).path)).toBe("Popup report.pdf");
    expect(cancelled).toEqual([]);
    await store.close();
  });

  test("cancels a followed download whose partial file outgrows its quota", async () => {
    const { store } = await fixture({ maxFileBytes: 5, maxSessionBytes: 20 });
    await store.begin({ guid: "huge", targetId: "closed", suggestedFilename: "huge.bin" });
    const cancelled: string[] = [];
    store.followUnreported("huge", async (reason) => {
      cancelled.push(reason);
      await store.reject("huge", reason);
    });
    await writeFile(join(store.filesDirectory, "huge.bin.crdownload"), "ten bytes!");
    expect(await settledDownload(store)).toMatchObject({
      status: "failed",
      failureCode: "download_quota_exceeded",
    });
    expect(cancelled).toEqual(["download_quota_exceeded"]);
    await store.close();
  });

  test("recognizes the names Chromium gives a download", () => {
    expect(chromiumCopyNumber("report.pdf", "report.pdf")).toBe(0);
    expect(chromiumCopyNumber("report.pdf", "report (3).pdf")).toBe(3);
    expect(chromiumCopyNumber("archive.tar.gz", "archive (1).tar.gz")).toBe(1);
    expect(chromiumCopyNumber("README", "README (2)")).toBe(2);
    expect(chromiumCopyNumber("report.pdf", "report (x).pdf")).toBeNull();
    expect(chromiumCopyNumber("report.pdf", "other.pdf")).toBeNull();
    expect(chromiumCopyNumber("report.pdf", "report.pdf.crdownload")).toBeNull();
  });

  test("never follows a reported file outside its folder", async () => {
    const { store } = await fixture();
    await store.begin({ guid: "escape", targetId: null, suggestedFilename: "x.txt" });
    const outside = join(store.rootDirectory, "outside.txt");
    await writeFile(outside, "elsewhere");
    await store.progress({
      guid: "escape",
      state: "completed",
      receivedBytes: 9,
      totalBytes: 9,
      filePath: outside,
    });
    expect((await store.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    expect(await readFile(outside, "utf8")).toBe("elsewhere");
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

  test("publishes exact synthetic CSV bytes idempotently without persisting signed authority", async () => {
    const rootDirectory = await newRoot();
    const store = await BrowserDownloadStore.open({
      rootDirectory,
      browserSessionId,
      controllerGeneration,
      createId: () => firstDownloadId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const csv = Buffer.from('item,total\r\n"Generated ""fixture"" æ",12.50\r\n');
    await store.begin({ guid: "exported", targetId: null, suggestedFilename: "synthetic.csv" });
    await writeFile(join(store.filesDirectory, "exported"), csv);
    await store.progress({
      guid: "exported",
      state: "completed",
      receivedBytes: 46,
      totalBytes: 46,
    });
    const operationId = "44444444-4444-4444-8444-444444444444";
    const uploads: string[] = [];
    const authority = (signature: string) => ({
      operationId,
      downloadId: firstDownloadId,
      upload: {
        url: `https://storage.test/object?signature=${signature}`,
        requiredHeaders: { "content-type": "application/octet-stream" },
        expiresAt: "2026-08-10T12:15:00.000Z",
      },
    });
    const upload = async (
      path: string,
      grant: { url: string; requiredHeaders: Record<string, string>; expiresAt: string },
      expected: { sizeBytes: number; sha256: string },
    ) => {
      uploads.push(grant.url);
      expect(await readFile(path)).toEqual(csv);
      expect(expected).toEqual({
        sizeBytes: 46,
        sha256: "0e9ba0cd29d7b88fa02b369c70aee7080847a6efe176dce34ac598b84097c52c",
      });
    };

    expect(await store.export(authority("private-one"), upload)).toMatchObject({
      operationId,
      downloadId: firstDownloadId,
      replayed: false,
    });
    expect(await store.export(authority("private-two"), upload)).toMatchObject({
      operationId,
      downloadId: firstDownloadId,
      replayed: true,
    });
    expect(uploads).toEqual(["https://storage.test/object?signature=private-one"]);
    await store.close();
    const databaseBytes = await readFile(join(rootDirectory, "downloads.sqlite"));
    expect(databaseBytes.includes(Buffer.from("private-one"))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("storage.test"))).toBe(false);
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

async function settledDownload(store: BrowserDownloadStore) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const download = (await store.list())[0];
    if (download && download.status !== "in_progress") return download;
    await Bun.sleep(50);
  }
  throw new Error("browser download did not settle");
}
