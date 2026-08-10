import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadBrowserDownload, validateDownloadUploadAuthority } from "../src";

const sha256 = "cab2b47a987c2db44dda774d9a594af4e5cadad9ba7ec27d2d8571b9c97d0350";

describe("browser download publication", () => {
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
