import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceArchiveSpool } from "../src/sandbox/archive-spool";
import {
  captureHostWorkspaceArchive,
  fingerprintHostWorkspace,
  restoreHostWorkspaceArchive,
} from "../src/sandbox/host-archive-spool";

const roots: string[] = [];
const spools: WorkspaceArchiveSpool[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-archive-codec-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(text: string | Uint8Array, chunkBytes = 7): WorkspaceArchiveSpool {
  const bytes = typeof text === "string" ? Buffer.from(text) : Buffer.from(text);
  return {
    path: "unused-input-path",
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    async *open() {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        yield bytes.subarray(offset, offset + chunkBytes);
      }
    },
    async dispose() {},
  };
}

function reference(directories: string[], files: Array<{ path: string; data: string }>) {
  const hash = createHash("sha256");
  const frame = (label: string, value: string) =>
    hash.update(`${label}\0${Buffer.byteLength(value)}\0${value}\0`);
  frame("projection", "sdk_local_archive_v1");
  for (const path of [...directories].sort()) frame("dir", path);
  let totalFileBytes = 0;
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const content = Buffer.from(file.data, "base64");
    frame("file", file.path);
    frame("bytes", String(content.length));
    hash.update(content);
    totalFileBytes += content.length;
  }
  return {
    algorithm: "sha256",
    sha256: hash.digest("hex"),
    entryCount: directories.length + files.length,
    fileCount: files.length,
    totalFileBytes,
    projection: "sdk_local_archive_v1",
  };
}

describe("disk-backed SDK v1 host archive codec", () => {
  test("capture encoding and validation do not allocate new payload backing stores per chunk", async () => {
    const source = await fixture();
    await writeFile(join(source, "file"), Buffer.alloc(2 * 1024 * 1024 + 1, 251));
    const originalFrom = Buffer.from;
    const originalConcat = Buffer.concat;
    let payloadCopies = 0;
    const fromHook = spyOn(Buffer, "from").mockImplementation((...args) => {
      const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
      if (result.length >= 32 * 1024) payloadCopies++;
      return result;
    });
    const concatHook = spyOn(Buffer, "concat").mockImplementation((...args) => {
      const result = Reflect.apply(originalConcat, Buffer, args) as Buffer;
      if (result.length >= 32 * 1024) payloadCopies++;
      return result;
    });
    try {
      const captured = await captureHostWorkspaceArchive(source, []);
      spools.push(captured.spool);
      expect(payloadCopies).toBe(0);
    } finally {
      fromHook.mockRestore();
      concatHook.mockRestore();
    }
  });

  test("capture has exact framed fingerprint, bounded chunks, and idempotent disposal", async () => {
    const root = await fixture();
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "目录"));
    await writeFile(join(root, "目录", "🙂.txt"), "hello\0æ🙂");
    await writeFile(join(root, "zero"), "");
    await writeFile(join(root, "binary"), Buffer.alloc(196_613, 251));
    await writeFile(join(root, "excluded"), "secret fixture");
    await symlink("binary", join(root, "link"));
    const captured = await captureHostWorkspaceArchive(root, ["excluded"]);
    spools.push(captured.spool);
    const parts: Buffer[] = [];
    for await (const part of captured.spool.open()) {
      expect(part.length).toBeLessThanOrEqual(65_536);
      parts.push(Buffer.from(part));
    }
    const bytes = Buffer.concat(parts);
    const archive = JSON.parse(bytes.toString());
    expect(archive.version).toBe(1);
    expect(archive.files.map((file: { path: string }) => file.path)).not.toContain("link");
    expect(captured.workspace).toEqual(reference(archive.directories, archive.files));
    expect(await fingerprintHostWorkspace(root, ["excluded"])).toEqual(captured.workspace);
    expect(captured.spool.byteSize).toBe(bytes.length);
    expect(captured.spool.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const destination = await fixture();
    await restoreHostWorkspaceArchive(destination, captured.spool);
    expect(await fingerprintHostWorkspace(destination, [])).toEqual(captured.workspace);
    await captured.spool.dispose();
    await captured.spool.dispose();
    await expect(readFile(captured.spool.path)).rejects.toThrow();
  });

  test("legacy JSON, escaped base64, reordered fields, and every small byte boundary", async () => {
    const text =
      '{ "files": [{"data":"AAE\\u002f\\/w==","path":"目录/🙂"}, {"path":"empty","data":""}], "directories": ["目录"], "version":1.0 }';
    for (let chunkBytes = 1; chunkBytes <= 17; chunkBytes++) {
      const destination = await fixture();
      await restoreHostWorkspaceArchive(destination, input(text, chunkBytes), { chunkBytes });
      expect(await readFile(join(destination, "目录", "🙂"))).toEqual(
        Buffer.from("AAE//w==", "base64"),
      );
      expect(await readFile(join(destination, "empty"))).toHaveLength(0);
    }
  });

  test("reusable decoder agrees with native base64 across every byte value and padding remainder", async () => {
    const files = Array.from({ length: 258 }, (_, size) => ({
      path: `file-${size}`,
      data: Buffer.from(
        Array.from({ length: size }, (_byte, index) => (size * 31 + index * 17) & 255),
      ).toString("base64"),
    }));
    const archive = input(JSON.stringify({ version: 1, directories: [], files }));
    for (const chunkBytes of [7, 65_536]) {
      const destination = await fixture();
      await restoreHostWorkspaceArchive(destination, archive, { chunkBytes });
      for (const file of files) {
        expect(await readFile(join(destination, file.path))).toEqual(
          Buffer.from(file.data, "base64"),
        );
      }
      expect(await fingerprintHostWorkspace(destination, [])).toEqual(reference([], files));
    }
  });

  test("malformed document/path/content/hash never changes the destination", async () => {
    const destination = await fixture();
    await writeFile(join(destination, "keep"), "unchanged");
    const bad = [
      '{"version":1,"directories":[],"files":[]} trailing',
      '{"version":1,"directories":[],"files":[],"version":1}',
      '{"version":2,"directories":[],"files":[]}',
      '{"version":1,"directories":[],"files":[],}',
      '{"version":1,"directories":["../outside"],"files":[]}',
      '{"version":1,"directories":["/absolute"],"files":[]}',
      '{"version":1,"directories":["a//b"],"files":[]}',
      '{"version":1,"directories":["a\\u0000b"],"files":[]}',
      '{"version":1,"directories":["a\\ud800"],"files":[]}',
      '{"version":1,"directories":["a"],"files":[{"path":"a","data":""}]}',
      '{"version":1,"directories":["a/b"],"files":[{"path":"a","data":""}]}',
      ...["YQ", "YR==", "YQ===", "YQ==AAAA", "!!!!", "Y Q==", "é"].map((data) =>
        JSON.stringify({ version: 1, directories: [], files: [{ path: "file", data }] }),
      ),
      '{"version":1,"directories":[],"files":[{"path":"file","data":"YQ=="}',
    ];
    for (const text of bad) {
      await expect(
        restoreHostWorkspaceArchive(destination, input(text), { chunkBytes: 3 }),
      ).rejects.toThrow();
      expect(await readdir(destination)).toEqual(["keep"]);
      expect(await readFile(join(destination, "keep"), "utf8")).toBe("unchanged");
    }
    const valid = input('{"version":1,"directories":[],"files":[]}');
    await expect(
      restoreHostWorkspaceArchive(destination, { ...valid, sha256: "0".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      restoreHostWorkspaceArchive(destination, { ...valid, byteSize: valid.byteSize + 1 }),
    ).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("unchanged");
  });

  test("unrepresentable filename components are rejected before destination mutation", async () => {
    const destination = await fixture();
    await writeFile(join(destination, "keep"), "unchanged");
    for (const component of ["x".repeat(256), "é".repeat(128), "🙂".repeat(64)]) {
      for (const directory of [false, true]) {
        const archive = input(
          JSON.stringify({
            version: 1,
            directories: directory ? [component] : [],
            files: directory ? [] : [{ path: `nested/${component}`, data: "YQ==" }],
          }),
        );
        await expect(restoreHostWorkspaceArchive(destination, archive)).rejects.toThrow();
        expect(await readdir(destination)).toEqual(["keep"]);
        expect(await readFile(join(destination, "keep"), "utf8")).toBe("unchanged");
      }
    }
  });

  test("restore pins hash and size expectations before calling the spool producer", async () => {
    const destination = await fixture();
    await writeFile(join(destination, "keep"), "unchanged");
    const original = input(
      JSON.stringify({ version: 1, directories: [], files: [{ path: "file", data: "YQ==" }] }),
    );
    for (const data of ["Yg==", "YWJjZA=="]) {
      const replacement = input(
        JSON.stringify({ version: 1, directories: [], files: [{ path: "file", data }] }),
      );
      const malicious: WorkspaceArchiveSpool = {
        ...original,
        async *open() {
          malicious.byteSize = replacement.byteSize;
          malicious.sha256 = replacement.sha256;
          yield* replacement.open();
        },
      };
      await expect(restoreHostWorkspaceArchive(destination, malicious)).rejects.toThrow();
      expect(await readdir(destination)).toEqual(["keep"]);
      expect(await readFile(join(destination, "keep"), "utf8")).toBe("unchanged");
    }
  });

  test("representable 255-byte ASCII and Unicode filename components remain readable", async () => {
    const destination = await fixture();
    for (const path of ["x".repeat(255), `${"é".repeat(127)}x`, `${"🙂".repeat(63)}abc`]) {
      expect(Buffer.byteLength(path)).toBe(255);
      await restoreHostWorkspaceArchive(
        destination,
        input(
          JSON.stringify({
            version: 1,
            directories: [],
            files: [{ path, data: "YQ==" }],
          }),
        ),
      );
      expect(await readFile(join(destination, path), "utf8")).toBe("a");
    }
  });

  test("the producer cannot change the selected archive limits during restore", async () => {
    const destination = await fixture();
    await writeFile(join(destination, "keep"), "unchanged");
    const archive = input(
      JSON.stringify({ version: 1, directories: [], files: [{ path: "file", data: "YWI=" }] }),
    );
    const options = { archiveLimits: { maxExtractedBytes: 1 as number | null } };
    await expect(
      restoreHostWorkspaceArchive(
        destination,
        {
          ...archive,
          async *open() {
            options.archiveLimits.maxExtractedBytes = null;
            yield* archive.open();
          },
        },
        options,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("unchanged");
  });

  test("symlink roots/ancestors cannot redirect capture or restore; child symlinks are removed, not followed", async () => {
    const outer = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "keep"), "safe");
    await symlink(outside, join(outer, "link"));
    const empty = input('{"version":1,"directories":[],"files":[]}');
    await expect(fingerprintHostWorkspace(join(outer, "link"), [])).rejects.toThrow();
    await expect(restoreHostWorkspaceArchive(join(outer, "link"), empty)).rejects.toThrow();
    await expect(restoreHostWorkspaceArchive(join(outer, "link", "new"), empty)).rejects.toThrow();
    await restoreHostWorkspaceArchive(outer, empty);
    expect(await readdir(outer)).toEqual([]);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("safe");
  });

  test("optional SDK limits remain opt-in and reject before destination mutation", async () => {
    const destination = await fixture();
    await writeFile(join(destination, "keep"), "safe");
    const archive = input(
      JSON.stringify({ version: 1, directories: [], files: [{ path: "file", data: "YWI=" }] }),
    );
    await expect(
      restoreHostWorkspaceArchive(destination, archive, {
        archiveLimits: { maxExtractedBytes: 1 },
      }),
    ).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("safe");
    await restoreHostWorkspaceArchive(destination, archive, { archiveLimits: null });
    expect(await readFile(join(destination, "file"), "utf8")).toBe("ab");
  });

  test("SDK 0.14.x producer and consumer interoperate in both directions", async () => {
    const sdk = await import(
      new URL(
        "./sandbox/sandboxes/shared/localSnapshots.mjs",
        import.meta.resolve("@openai/agents-core"),
      ).href
    );
    const source = await fixture();
    await mkdir(join(source, "directory"));
    await writeFile(join(source, "directory", "file"), Buffer.from([0, 1, 2, 253, 254, 255]));
    const destination = await fixture();
    await restoreHostWorkspaceArchive(
      destination,
      input(await sdk.createWorkspaceArchive(source, new Set())),
    );
    expect(await fingerprintHostWorkspace(destination, [])).toEqual(
      await fingerprintHostWorkspace(source, []),
    );
    const captured = await captureHostWorkspaceArchive(source, []);
    spools.push(captured.spool);
    await sdk.restoreWorkspaceArchive(await readFile(captured.spool.path), destination);
    expect(await fingerprintHostWorkspace(destination, [])).toEqual(captured.workspace);
  });

  test("same-size file mutation during capture read is detected and private spool is cleaned", async () => {
    const source = await fixture();
    const temporaryBase = await fixture();
    await writeFile(join(source, "file"), "initial");
    const previousTemp = process.env.TMPDIR;
    process.env.TMPDIR = temporaryBase;
    const originalOpen = filesystem.open;
    let reads = 0;
    const hook = spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if ((await realpath(String(args[0])).catch(() => "")) === join(source, "file")) {
        const originalRead = handle.read;
        Object.defineProperty(handle, "read", {
          value: async (...readArgs: Parameters<typeof originalRead>) => {
            const result = await Reflect.apply(originalRead, handle, readArgs);
            if (++reads === 2) await writeFile(join(source, "file"), "mutated");
            return result;
          },
        });
      }
      return handle;
    });
    try {
      await expect(captureHostWorkspaceArchive(source, [])).rejects.toMatchObject({
        code: "workspace_changed_during_capture",
      });
      expect(reads).toBe(2);
      expect(await readdir(temporaryBase)).toEqual([]);
    } finally {
      hook.mockRestore();
      if (previousTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemp;
    }
  });

  test("directory replacement between lstat and open cannot capture a symlink target", async () => {
    const source = await fixture();
    const outside = await fixture();
    await mkdir(join(source, "directory"));
    await writeFile(join(outside, "secret"), "outside fixture");
    const originalOpen = filesystem.open;
    let swapped = false;
    const hook = spyOn(filesystem, "open").mockImplementation(async (...args) => {
      if (!swapped && /^\/proc\/self\/fd\/\d+\/directory$/.test(String(args[0]))) {
        swapped = true;
        await rename(join(source, "directory"), join(source, "old-directory"));
        await symlink(outside, join(source, "directory"));
      }
      return originalOpen(...args);
    });
    try {
      await expect(captureHostWorkspaceArchive(source, [])).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside fixture");
    } finally {
      hook.mockRestore();
    }
  });

  test("destination parent swap cannot redirect the exclusive file write", async () => {
    const destination = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "file"), "outside fixture");
    const archive = input(
      JSON.stringify({
        version: 1,
        directories: ["directory"],
        files: [{ path: "directory/file", data: "YQ==" }],
      }),
    );
    const originalOpen = filesystem.open;
    let swapped = false;
    const hook = spyOn(filesystem, "open").mockImplementation(async (...args) => {
      if (!swapped && /^\/proc\/self\/fd\/\d+\/file$/.test(String(args[0]))) {
        swapped = true;
        await rename(join(destination, "directory"), join(destination, "old-directory"));
        await symlink(outside, join(destination, "directory"));
      }
      return originalOpen(...args);
    });
    try {
      await expect(restoreHostWorkspaceArchive(destination, archive)).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(await readFile(join(outside, "file"), "utf8")).toBe("outside fixture");
    } finally {
      hook.mockRestore();
    }
  });

  test("numeric version and UTF-8 validation do not depend on buffer boundaries", async () => {
    const destination = await fixture();
    for (const version of ["1", "1.0000", "0.001e3", "100e-2", "1E+000"]) {
      await restoreHostWorkspaceArchive(
        destination,
        input(`{"version":${version},"directories":[],"files":[]}`),
        { chunkBytes: 1 },
      );
    }
    await writeFile(join(destination, "keep"), "safe");
    for (const version of [
      "01",
      "+1",
      "1.",
      "1e",
      "1e+",
      "-1",
      "1e100000000000000000000",
      "1.01",
    ]) {
      await expect(
        restoreHostWorkspaceArchive(
          destination,
          input(`{"version":${version},"directories":[],"files":[]}`),
          { chunkBytes: 1 },
        ),
      ).rejects.toThrow();
    }
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"version":1,"directories":["'),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('"],"files":[]}'),
    ]);
    await expect(
      restoreHostWorkspaceArchive(destination, input(invalidUtf8), { chunkBytes: 1 }),
    ).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("safe");
  });

  test("short filesystem reads preserve every base64 remainder and empty/excluded projections", async () => {
    const source = await fixture();
    for (let size = 0; size <= 19; size++) {
      await writeFile(
        join(source, `file-${size}`),
        Buffer.from(Array.from({ length: size }, (_, index) => index * 13)),
      );
    }
    const originalOpen = filesystem.open;
    const hook = spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if ((await realpath(String(args[0])).catch(() => "")).startsWith(`${source}/file-`)) {
        const originalRead = handle.read;
        Object.defineProperty(handle, "read", {
          value: async (buffer: Buffer, offset: number, length: number, position: number) =>
            Reflect.apply(originalRead, handle, [buffer, offset, Math.min(length, 5), position]),
        });
      }
      return handle;
    });
    try {
      const captured = await captureHostWorkspaceArchive(source, []);
      spools.push(captured.spool);
      const archive = JSON.parse(await readFile(captured.spool.path, "utf8"));
      for (const file of archive.files)
        expect(Buffer.from(file.data, "base64")).toEqual(await readFile(join(source, file.path)));
      expect(captured.workspace).toEqual(reference(archive.directories, archive.files));
    } finally {
      hook.mockRestore();
    }
    const empty = await captureHostWorkspaceArchive(source, [""]);
    spools.push(empty.spool);
    expect(empty.workspace).toEqual(reference([], []));
    expect(JSON.parse(await readFile(empty.spool.path, "utf8"))).toEqual({
      version: 1,
      directories: [],
      files: [],
    });
    expect((await filesystem.stat(empty.spool.path)).mode & 0o777).toBe(0o600);
    expect((await filesystem.stat(join(empty.spool.path, ".."))).mode & 0o777).toBe(0o700);
  });

  test("failed source streams clean their private copy without creating a destination", async () => {
    const outer = await fixture();
    const temporaryBase = await fixture();
    const destination = join(outer, "missing");
    const previousTemp = process.env.TMPDIR;
    process.env.TMPDIR = temporaryBase;
    const archive = input('{"version":1,"directories":[],"files":[]}');
    try {
      await expect(
        restoreHostWorkspaceArchive(destination, {
          ...archive,
          async *open() {
            yield Buffer.from("{");
            throw new Error("fixture source failed");
          },
        }),
      ).rejects.toThrow("fixture source failed");
      expect(await readdir(temporaryBase)).toEqual([]);
      expect(await readdir(outer)).toEqual([]);
    } finally {
      if (previousTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemp;
    }
  });
});
