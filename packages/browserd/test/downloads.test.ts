import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
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
    expect(await readFile((await store.completedFile(firstDownloadId)).path, "utf8")).toBe(
      "%PDF bytes",
    );
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

  test("keeps each download's bytes when a later one replaces its name", async () => {
    const rootDirectory = await newRoot();
    let next = 0;
    const ids = [firstDownloadId, secondDownloadId];
    const open = async () =>
      await BrowserDownloadStore.open({
        rootDirectory,
        browserSessionId,
        controllerGeneration,
        createId: () => ids[next++]!,
      });
    const store = await open();
    const path = join(store.filesDirectory, "report.pdf");
    const save = async (guid: string, bytes: string) => {
      await store.begin({ guid, targetId: null, suggestedFilename: "report.pdf" });
      // Chromium writes a partial file and renames it over the final name.
      await rename(await partial(store, guid, bytes), path);
      await store.progress({
        guid,
        state: "completed",
        receivedBytes: bytes.length,
        totalBytes: bytes.length,
        filePath: path,
      });
    };
    await save("first-guid", "first report");
    await save("second-guid", "second, longer report");
    const read = async (current: BrowserDownloadStore, id: string) =>
      await readFile((await current.completedFile(id)).path, "utf8");
    expect(await read(store, firstDownloadId)).toBe("first report");
    expect(await read(store, secondDownloadId)).toBe("second, longer report");
    expect(await readFile(path, "utf8")).toBe("second, longer report");
    await store.close();

    const reopened = await open();
    expect(await reopened.get(firstDownloadId)).toMatchObject({ status: "completed" });
    expect(await read(reopened, firstDownloadId)).toBe("first report");
    expect(await read(reopened, secondDownloadId)).toBe("second, longer report");
    expect(await readFile(path, "utf8")).toBe("second, longer report");
    await reopened.close();
  });

  test("refuses bytes that replaced a download before they were kept", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.pdf");
    await store.begin({ guid: "early", targetId: null, suggestedFilename: "report.pdf" });
    // Another download with the same name finished first and replaced the file.
    await writeFile(path, "someone else's longer bytes");
    await store.progress({
      guid: "early",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect((await store.list())[0]).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    // The other download's file is left in place.
    expect(await readFile(path, "utf8")).toBe("someone else's longer bytes");
    await store.close();
  });

  test("refuses both downloads when equal-sized bytes replaced one before it was kept", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    // Chromium saved the first file, then the second replaced it before the
    // first completion was handled. Both are five bytes.
    await writeFile(path, "AAAAA");
    await rename(await partial(store, "second", "BBBBB"), path);
    const complete = async (guid: string) =>
      await store.progress({
        guid,
        state: "completed",
        receivedBytes: 5,
        totalBytes: 5,
        filePath: path,
      });
    await complete("first");
    // Not settled while the other download with its name is still running.
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await expect(store.completedFile(firstDownloadId)).rejects.toThrow("in progress");
    await complete("second");
    for (const id of [firstDownloadId, secondDownloadId]) {
      expect(await store.get(id)).toMatchObject({
        status: "failed",
        failureCode: "download_integrity_failed",
      });
    }
    await store.close();
  });

  test("refuses an equal-sized replacement on a file system without hard links", async () => {
    const link = spyOn(fsPromises, "link").mockImplementation(async () => {
      throw Object.assign(new Error("hard links are not supported"), { code: "ENOTSUP" });
    });
    try {
      const { store } = await fixture();
      const path = join(store.filesDirectory, "report.txt");
      await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
      await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
      await writeFile(path, "AAAAA");
      await rename(await partial(store, "second", "BBBBB"), path);
      for (const guid of ["first", "second"]) {
        await store.progress({
          guid,
          state: "completed",
          receivedBytes: 5,
          totalBytes: 5,
          filePath: path,
        });
      }
      expect(link).toHaveBeenCalled();
      for (const id of [firstDownloadId, secondDownloadId]) {
        expect(await store.get(id)).toMatchObject({
          status: "failed",
          failureCode: "download_integrity_failed",
        });
      }
      await store.close();
    } finally {
      link.mockRestore();
    }
  });

  test("sees a same-name download announced before the event barrier", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    // The second download replaced the first file before the first
    // completion was handled; its begin event was still on its way.
    await writeFile(path, "AAAAA");
    await rename(await partial(store, "second", "BBBBB"), path);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
      eventBarrier: () => barrier,
    });
    void store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    release();
    await Bun.sleep(0);
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await store.progress({
      guid: "second",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect(await store.get(firstDownloadId)).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    await store.close();
  });

  test("a peer finished over quota fails a held download whose file it replaced", async () => {
    const { store } = await fixture({ maxFileBytes: 8, maxSessionBytes: 8 });
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    await writeFile(path, "AAAAA");
    await rename(await partial(store, "second", "BBBBB"), path);
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    // Chromium reports the second completion before the caller rejects it.
    await expect(
      store.progress({
        guid: "second",
        state: "completed",
        receivedBytes: 5,
        totalBytes: 5,
        filePath: path,
      }),
    ).resolves.toEqual({ cancelReason: "download_quota_exceeded" });
    await store.reject("second", "download_quota_exceeded");
    expect(await store.get(firstDownloadId)).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    await store.close();
  });

  test("an unconfirmed cancellation keeps a held download waiting for its peer", async () => {
    const { store } = await fixture({ maxFileBytes: 8, maxSessionBytes: 16 });
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    await writeFile(path, "AAAAA");
    await rename(await partial(store, "second", "BBBBB"), path);
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    await expect(
      store.progress({ guid: "second", state: "inProgress", receivedBytes: 9, totalBytes: 9 }),
    ).resolves.toEqual({ cancelReason: "download_quota_exceeded" });
    // Chromium refused the cancellation, so the second download may still
    // have saved a file.
    await store.reject("second", "download_quota_exceeded", "uncertain");
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await store.progress({
      guid: "second",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect(await store.get(firstDownloadId)).toMatchObject({
      status: "failed",
      failureCode: "download_integrity_failed",
    });
    await store.close();
  });

  test("names that may be one file on disk are treated as the same name", async () => {
    const { store } = await fixture();
    // On a case-insensitive file system both names are this one file.
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "REPORT.TXT" });
    await writeFile(path, "AAAAA");
    await rename(await partial(store, "second", "BBBBB"), path);
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await store.progress({
      guid: "second",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    for (const id of [firstDownloadId, secondDownloadId]) {
      expect(await store.get(id)).toMatchObject({
        status: "failed",
        failureCode: "download_integrity_failed",
      });
    }
    await store.close();
  });

  test("a held download settles when a same-name peer is cancelled", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    await rename(await partial(store, "first", "AAAAA"), path);
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await store.progress({ guid: "second", state: "canceled", receivedBytes: 2, totalBytes: 5 });
    expect(await readFile((await store.completedFile(firstDownloadId)).path, "utf8")).toBe("AAAAA");
    await store.close();
  });

  test("settles overlapping same-name downloads once both bytes are known", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "first", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "second", targetId: null, suggestedFilename: "report.txt" });
    await rename(await partial(store, "first", "AAAAA"), path);
    await store.progress({
      guid: "first",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    expect((await store.get(firstDownloadId))?.status).toBe("in_progress");
    await rename(await partial(store, "second", "BBBBB"), path);
    await store.progress({
      guid: "second",
      state: "completed",
      receivedBytes: 5,
      totalBytes: 5,
      filePath: path,
    });
    const read = async (id: string) => await readFile((await store.completedFile(id)).path, "utf8");
    expect(await read(firstDownloadId)).toBe("AAAAA");
    expect(await read(secondDownloadId)).toBe("BBBBB");
    await store.close();
  });

  test("a late completion of a rejected download leaves another download's file", async () => {
    const { store } = await fixture();
    const path = join(store.filesDirectory, "report.txt");
    await store.begin({ guid: "rejected", targetId: null, suggestedFilename: "report.txt" });
    await store.begin({ guid: "kept", targetId: null, suggestedFilename: "report.txt" });
    await store.reject("rejected", "download_quota_exceeded", "confirmed");
    await rename(await partial(store, "kept", "kept bytes"), path);
    await store.progress({
      guid: "rejected",
      state: "completed",
      receivedBytes: 10,
      totalBytes: 10,
      filePath: path,
    });
    expect(await readFile(path, "utf8")).toBe("kept bytes");
    await store.progress({
      guid: "kept",
      state: "completed",
      receivedBytes: 10,
      totalBytes: 10,
      filePath: path,
    });
    expect(await readFile((await store.completedFile(secondDownloadId)).path, "utf8")).toBe(
      "kept bytes",
    );
    await store.close();
  });

  test("adopts a named download completed before downloads were kept apart", async () => {
    const rootDirectory = await newRoot();
    const open = async () =>
      await BrowserDownloadStore.open({
        rootDirectory,
        browserSessionId,
        controllerGeneration,
        createId: () => firstDownloadId,
      });
    const store = await open();
    const path = join(store.filesDirectory, "notes.txt");
    await store.begin({ guid: "older", targetId: null, suggestedFilename: "notes.txt" });
    await writeFile(path, "older bytes");
    await store.progress({
      guid: "older",
      state: "completed",
      receivedBytes: 11,
      totalBytes: 11,
      filePath: path,
    });
    await store.close();
    // An earlier version kept only Chromium's file.
    await rm(join(rootDirectory, "stored"), { recursive: true, force: true });
    const reopened = await open();
    expect(await readFile((await reopened.completedFile(firstDownloadId)).path, "utf8")).toBe(
      "older bytes",
    );
    expect(await readFile(path, "utf8")).toBe("older bytes");
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

/** A partial file as Chromium writes it before renaming it into place. */
async function partial(store: BrowserDownloadStore, guid: string, bytes: string) {
  const path = join(store.filesDirectory, `Unconfirmed ${guid}.crdownload`);
  await writeFile(path, bytes);
  return path;
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/opengeni-browser-downloads-");
  roots.push(root);
  return root;
}
