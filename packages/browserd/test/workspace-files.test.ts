import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrowserWorkspaceFileStager } from "../src";

describe("browser workspace-file staging", () => {
  test("materializes exact private bytes once and replays without retaining authority", async () => {
    const bytes = Buffer.from("workspace upload payload", "utf8");
    let downloads = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        downloads += 1;
        return new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        });
      },
    });
    const root = await mkdtemp("/tmp/ogb-workspace-files-");
    const operationId = randomUUID();
    const fileId = randomUUID();
    try {
      const stager = await BrowserWorkspaceFileStager.open({ rootDirectory: root });
      const request = authorityRequest({
        operationId,
        fileId,
        url: `${server.url}/object?signature=never-persist-me`,
        bytes,
      });
      const [first, concurrentReplay] = await Promise.all([
        stager.stage(request),
        stager.stage(request),
      ]);
      expect(first.replayed).toBe(false);
      expect(concurrentReplay.replayed).toBe(true);
      expect(downloads).toBe(1);

      const [path] = await stager.resolve(operationId, [fileId]);
      expect(path).toEndWith("/report.txt");
      expect(await readFile(path!)).toEqual(bytes);
      expect((await stat(path!)).mode & 0o777).toBe(0o400);
      const manifest = await readFile(join(root, operationId, "manifest.json"), "utf8");
      expect(manifest).not.toContain("signature");
      expect(manifest).not.toContain(server.url.toString());

      const expiredReplay = await stager.stage({
        ...request,
        files: request.files.map((file) => ({
          ...file,
          download: { ...file.download, expiresAt: "2026-08-10T00:00:00.000Z" },
        })),
      });
      expect(expiredReplay.replayed).toBe(true);
      expect(downloads).toBe(1);

      const manifestPath = join(root, operationId, "manifest.json");
      const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: Array<{ safeFilename: string }>;
      };
      tampered.files[0]!.safeFilename = "tampered.txt";
      await writeFile(manifestPath, JSON.stringify(tampered));
      expect(await stager.resolve(operationId, [fileId])).toEqual([]);
      expect((await stager.stage(request)).replayed).toBe(false);
      expect(downloads).toBe(2);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds one operation to one stable file envelope", async () => {
    const bytes = Buffer.from("same bytes", "utf8");
    const server = Bun.serve({ port: 0, fetch: () => new Response(bytes) });
    const root = await mkdtemp("/tmp/ogb-workspace-files-conflict-");
    const operationId = randomUUID();
    const fileId = randomUUID();
    try {
      const stager = await BrowserWorkspaceFileStager.open({ rootDirectory: root });
      const request = authorityRequest({
        operationId,
        fileId,
        url: `${server.url}/object`,
        bytes,
      });
      await stager.stage(request);
      await expect(
        stager.stage({
          ...request,
          files: request.files.map((file) => ({ ...file, safeFilename: "other.txt" })),
        }),
      ).rejects.toMatchObject({
        code: "operation_conflict",
      });
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces one bounded staging budget across the browser session", async () => {
    const bytes = Buffer.from("12345", "utf8");
    const server = Bun.serve({ port: 0, fetch: () => new Response(bytes) });
    const root = await mkdtemp("/tmp/ogb-workspace-files-capacity-");
    try {
      const stager = await BrowserWorkspaceFileStager.open({
        rootDirectory: root,
        maxTotalBytes: 8,
      });
      const firstOperationId = randomUUID();
      const firstFileId = randomUUID();
      await stager.stage(
        authorityRequest({
          operationId: firstOperationId,
          fileId: firstFileId,
          url: `${server.url}/first`,
          bytes,
        }),
      );
      await expect(
        stager.stage(
          authorityRequest({
            operationId: randomUUID(),
            fileId: randomUUID(),
            url: `${server.url}/second`,
            bytes,
          }),
        ),
      ).rejects.toMatchObject({
        code: "resource_unavailable",
      });
      expect(await stager.resolve(firstOperationId, [firstFileId])).toHaveLength(1);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects redirects, truncation, excess bytes, and checksum mismatch without residue", async () => {
    const root = await mkdtemp("/tmp/ogb-workspace-files-invalid-");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/redirect") {
          return new Response(null, { status: 302, headers: { location: "/exact" } });
        }
        if (path === "/short") return new Response("12");
        if (path === "/long") return new Response("123456");
        return new Response("12345");
      },
    });
    try {
      const stager = await BrowserWorkspaceFileStager.open({ rootDirectory: root });
      for (const path of ["redirect", "short", "long", "wrong-hash"]) {
        const operationId = randomUUID();
        const request = authorityRequest({
          operationId,
          fileId: randomUUID(),
          url: `${server.url}/${path}`,
          bytes: Buffer.from("12345"),
        });
        if (path === "wrong-hash") request.files[0]!.sha256 = "0".repeat(64);
        await expect(stager.stage(request)).rejects.toMatchObject({
          code: "resource_unavailable",
        });
        expect(await stager.resolve(operationId, [request.files[0]!.fileId])).toEqual([]);
      }
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function authorityRequest(input: {
  operationId: string;
  fileId: string;
  url: string;
  bytes: Buffer;
}) {
  return {
    operationId: input.operationId,
    files: [
      {
        fileId: input.fileId,
        safeFilename: "report.txt",
        sizeBytes: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        download: {
          url: input.url,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ],
  };
}
