import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserDownloadStore,
  uploadBrowserDownload,
  validateDownloadUploadAuthority,
} from "../src";

const sha256 = "cab2b47a987c2db44dda774d9a594af4e5cadad9ba7ec27d2d8571b9c97d0350";

describe("browser download publication", () => {
  test("streams a 294 MiB export across request windows without repeating the PUT", async () => {
    const root = await mkdtemp("/tmp/opengeni-large-download-");
    const sizeBytes = 294 * 1024 * 1024;
    const store = await BrowserDownloadStore.open({
      rootDirectory: root,
      browserSessionId: randomUUID(),
      controllerGeneration: "controller-1",
    });
    const received = Promise.withResolvers<{ sizeBytes: number; sha256: string }>();
    const release = Promise.withResolvers<void>();
    let puts = 0;
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: sizeBytes + 1,
      async fetch(request) {
        puts++;
        let bytes = 0;
        const hash = createHash("sha256");
        for await (const chunk of request.body!) {
          bytes += chunk.byteLength;
          hash.update(chunk);
        }
        received.resolve({ sizeBytes: bytes, sha256: hash.digest("hex") });
        await release.promise;
        return new Response(null, { status: 200 });
      },
    });
    try {
      const download = await store.begin({
        guid: "large",
        targetId: null,
        suggestedFilename: "large.bin",
      });
      const path = join(store.filesDirectory, "large");
      // A sparse source exercises the real byte stream without a 294 MiB allocation.
      await writeFile(path, "");
      await truncate(path, sizeBytes);
      await store.progress({
        guid: "large",
        state: "completed",
        receivedBytes: sizeBytes,
        totalBytes: sizeBytes,
      });
      const request = {
        operationId: randomUUID(),
        downloadId: download.id,
        upload: {
          url: `${server.url}object?signature=first`,
          requiredHeaders: { "content-type": "application/octet-stream" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      expect(await store.upload(request, uploadBrowserDownload, 10)).toBeNull();
      const bytes = await received.promise;
      request.upload.url = `${server.url}object?signature=renewed`;
      expect(await store.upload(request, uploadBrowserDownload, 10)).toBeNull();
      release.resolve();
      const receipt = await store.upload(request, uploadBrowserDownload, 5_000);
      expect(receipt).toMatchObject({
        ...bytes,
        sizeBytes,
        operationId: request.operationId,
        downloadId: download.id,
      });
      expect(puts).toBe(1);
    } finally {
      release.resolve();
      await store.close();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("streams exact bytes through bounded provider authority", async () => {
    const root = await mkdtemp("/tmp/opengeni-download-upload-");
    const path = join(root, "file");
    await writeFile(path, "export me");
    let received = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("PUT");
        expect(request.headers.get("content-type")).toBe("application/octet-stream");
        expect(request.headers.get("x-goog-meta-sha256")).toBe(sha256);
        expect(request.headers.get("content-length")).toBe("9");
        received = await request.text();
        return new Response(null, { status: 200 });
      },
    });
    try {
      let streamedBody = false;
      await uploadBrowserDownload(
        path,
        {
          url: `${server.url}/object?signature=private`,
          requiredHeaders: {
            "content-type": "application/octet-stream",
            "x-goog-meta-sha256": sha256,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { sizeBytes: 9, sha256 },
        {
          fetch: async (input, init) => {
            streamedBody = init?.body instanceof ReadableStream;
            return await fetch(input, init);
          },
        },
      );
      expect(received).toBe("export me");
      expect(streamedBody).toBe(true);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unbound metadata and authority headers", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(() =>
      validateDownloadUploadAuthority(
        {
          url: "https://storage.test/object",
          requiredHeaders: {
            "content-type": "application/octet-stream",
            "x-goog-meta-sha256": "b".repeat(64),
          },
          expiresAt,
        },
        sha256,
      ),
    ).toThrow("metadata digest");
    expect(() =>
      validateDownloadUploadAuthority(
        {
          url: "https://storage.test/object",
          requiredHeaders: {
            "content-type": "application/octet-stream",
            authorization: "secret",
          },
          expiresAt,
        },
        sha256,
      ),
    ).toThrow("header is invalid");
  });
});
