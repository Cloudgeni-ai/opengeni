// The streamed workspace tar path: its validator must accept and reject
// exactly what the Agents SDK's whole-buffer validator does, however the
// archive is split into chunks, and the Modal stream methods must move a
// workspace with the SDK's commands, exclusions and refusals.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxArchiveError, SandboxUnsupportedFeatureError } from "@openai/agents/sandbox";
import type { WorkspaceArchiveSpool } from "../src/sandbox/archive-spool";
import { installModalWorkspaceTarStreams } from "../src/sandbox/providers/modal-workspace-tar-stream";
import {
  captureWorkspaceTarStreamToSpool,
  hydrateWorkspaceTarStreamFromSpool,
  readWorkspaceArchiveSpool,
  WorkspaceTarStreamValidator,
  workspaceTarStreamSession,
  type WorkspaceTarStreamSession,
  type WorkspaceTarStreamValidatorOptions,
} from "../src/sandbox/workspace-tar-stream";

const { validateWorkspaceTarArchive } = (await import(
  join(
    dirname(Bun.resolveSync("@openai/agents-extensions/sandbox/modal", import.meta.dir)),
    "../shared/archive.mjs",
  )
)) as {
  validateWorkspaceTarArchive: (
    data: Uint8Array,
    options: WorkspaceTarStreamValidatorOptions,
  ) => void;
};

type EntryOptions = { type?: string; size?: number; linkname?: string; mode?: number };

function header(name: string, options: EntryOptions & { size: number }): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(`${(options.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${options.size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(options.type ?? "0", 156);
  block.write(options.linkname ?? "", 157, 100);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function entry(name: string, data = "", options: EntryOptions = {}): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([
    header(name, { ...options, size: options.size ?? body.length }),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

function pax(records: Record<string, string>, type = "x"): Buffer {
  const body = Object.entries(records)
    .map(([key, value]) => {
      // "<length> <key>=<value>\n", where the length counts its own digits.
      const line = ` ${key}=${value}\n`;
      let length = line.length + 1;
      while (String(length).length + line.length !== length) {
        length = String(length).length + line.length;
      }
      return `${length}${line}`;
    })
    .join("");
  return entry("PaxHeader", body, { type });
}

function tar(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

async function run(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
  return new Uint8Array(stdout);
}

async function systemTars(): Promise<Record<string, Buffer>> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-tar-corpus-"));
  try {
    const long = `${"a-long-directory-name/".repeat(6)}file-with-a-long-name.txt`;
    await mkdir(join(root, dirname(long)), { recursive: true });
    await writeFile(join(root, long), "long\n");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/index.ts"), "export {};\n");
    await writeFile(join(root, "empty"), "");
    await mkdir(join(root, "tmp"));
    await writeFile(join(root, "tmp/scratch"), "scratch\n");
    await symlink("src/index.ts", join(root, "link"));
    const result: Record<string, Buffer> = {};
    for (const format of ["gnu", "pax", "ustar"]) {
      result[`system ${format} tar`] = Buffer.from(
        await run(["tar", `--format=${format}`, "--sort=name", "-C", root, "-cf", "-", "."]),
      );
    }
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LONG_PATH = `${"nested/".repeat(20)}file.txt`;
const CRAFTED: Record<string, Buffer> = {
  "plain tree": tar(
    entry("./", "", { type: "5", mode: 0o755 }),
    entry("./a.txt", "hello"),
    entry("./dir/", "", { type: "5" }),
    entry("./dir/b", "x".repeat(1500)),
  ),
  symlink: tar(entry("a.txt", "a"), entry("link", "", { type: "2", linkname: "a.txt" })),
  hardlink: tar(entry("a.txt", "a"), entry("hard", "", { type: "1", linkname: "a.txt" })),
  "parent escape": tar(entry("../evil", "x")),
  "absolute path": tar(entry("/etc/evil", "x")),
  "inner escape": tar(entry("a/../../evil", "x")),
  "duplicate file": tar(entry("a", "1"), entry("a", "2")),
  "duplicate directory": tar(entry("d/", "", { type: "5" }), entry("d/", "", { type: "5" })),
  "member below a file": tar(entry("a", "1"), entry("a/b", "2")),
  "file above a member": tar(entry("a/b", "2"), entry("a", "1")),
  "member below a symlink": tar(entry("l", "", { type: "2", linkname: "d" }), entry("l/x", "1")),
  "PAX path": tar(pax({ path: LONG_PATH }), entry("ignored", "data")),
  "PAX escape": tar(pax({ path: "../evil" }), entry("ignored", "data")),
  "PAX size override": tar(pax({ size: "1" }), entry("a", "data")),
  "global PAX path": tar(pax({ path: "x" }, "g"), entry("a", "data")),
  "global PAX comment": tar(pax({ comment: "hi" }, "g"), entry("a", "data")),
  "PAX sparse name": tar(pax({ "GNU.sparse.name": "x" }), entry("a", "data")),
  "GNU long name": tar(
    entry("././@LongLink", `${LONG_PATH}\0`, { type: "L" }),
    entry("short", "d"),
  ),
  "GNU long escape": tar(entry("././@LongLink", "../evil\0", { type: "L" }), entry("short", "d")),
  "character device": tar(entry("dev", "", { type: "3" })),
  fifo: tar(entry("fifo", "", { type: "6" })),
  "protected file": tar(entry("tmp/x", "1")),
  "protected directory": tar(entry("tmp/", "", { type: "5" })),
  "nested protected path": tar(entry("cache/x/y", "1")),
  "protected parent": tar(entry("cache/", "", { type: "5", mode: 0o755 })),
  "root directory": tar(entry("./", "", { type: "5", mode: 0o755 })),
  "write-only root directory": tar(entry("./", "", { type: "5", mode: 0o300 })),
  "lone zero block": Buffer.concat([entry("a", "1"), Buffer.alloc(512), entry("../evil", "x")]),
  "no end blocks": Buffer.concat([entry("a", "1")]),
  "truncated header": Buffer.concat([entry("a", "1"), entry("b", "2").subarray(0, 300)]),
  "truncated payload": Buffer.concat([entry("a", "x".repeat(2000)).subarray(0, 1024)]),
  "many members": tar(...["a", "b", "c", "d", "e"].map((name) => entry(name, "12"))),
  empty: Buffer.alloc(0),
};

const OPTION_SETS: Record<string, WorkspaceTarStreamValidatorOptions> = {
  capture: {},
  hydrate: { allowSymlinks: false, rejectRelPaths: ["tmp", "cache/x"] },
  "hydrate with an ephemeral root": { allowSymlinks: false, rejectRelPaths: [""] },
  limits: { archiveLimits: { maxMembers: 3, maxExtractedBytes: 5, maxInputBytes: 6000 } },
};

function outcome(check: () => void): string {
  try {
    check();
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxArchiveError);
    return (error as Error).message;
  }
}

/**
 * The SDK checks a member's payload length before the member, so for an
 * archive cut off inside a payload it names the truncation; a stream checks
 * the member at its header, before the truncation is visible, and may name
 * the member instead. Either way the archive is rejected.
 */
function comparable(result: string, sdkResult?: string): string {
  return sdkResult?.endsWith("truncated member payload") && result !== "ok"
    ? "rejected: truncated or unsafe"
    : result;
}

function streamed(bytes: Uint8Array, options: WorkspaceTarStreamValidatorOptions, size: number) {
  return outcome(() => {
    const validator = new WorkspaceTarStreamValidator(options);
    validator.checkInputBytes(bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      validator.push(bytes.subarray(offset, offset + size));
    }
    validator.finish();
  });
}

describe("WorkspaceTarStreamValidator", () => {
  test("accepts and rejects exactly what the SDK validator does, at every chunking", async () => {
    const corpus = { ...CRAFTED, ...(await systemTars()) };
    const accepted = new Set<string>();
    const rejected = new Set<string>();
    let random = 0x9e3779b9;
    for (const [name, bytes] of Object.entries(corpus)) {
      for (const [optionName, options] of Object.entries(OPTION_SETS)) {
        const expected = outcome(() => validateWorkspaceTarArchive(bytes, options));
        (expected === "ok" ? accepted : rejected).add(`${name} / ${optionName}`);
        for (const size of [1, 3, 100, 511, 512, 513, 4096, Math.max(bytes.byteLength, 1)]) {
          expect({
            name,
            optionName,
            size,
            result: comparable(streamed(bytes, options, size), expected),
          }).toEqual({
            name,
            optionName,
            size,
            result: comparable(expected, expected),
          });
        }
        // Irregular chunk boundaries across the whole archive.
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.byteLength;) {
          random = (random * 1_103_515_245 + 12_345) >>> 0;
          const size = 1 + (random % 1500);
          chunks.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
        const irregular = outcome(() => {
          const validator = new WorkspaceTarStreamValidator(options);
          validator.checkInputBytes(bytes.byteLength);
          for (const chunk of chunks) validator.push(chunk);
          validator.finish();
        });
        expect({ name, optionName, result: comparable(irregular, expected) }).toEqual({
          name,
          optionName,
          result: comparable(expected, expected),
        });
      }
    }
    // The corpus exercises both outcomes of every rule family.
    expect(accepted.has("system pax tar / capture")).toBe(true);
    expect(rejected.has("system pax tar / hydrate")).toBe(true);
    expect(rejected.has("member below a symlink / capture")).toBe(true);
    expect(rejected.has("many members / limits")).toBe(true);
    expect(accepted.has("lone zero block / hydrate")).toBe(true);
  });

  test("an unsafe member is rejected before any of its bytes can be forwarded", () => {
    const safe = entry("a.txt", "hello");
    const bytes = tar(safe, entry("../evil", "x"));
    const validator = new WorkspaceTarStreamValidator({ allowSymlinks: false });
    validator.push(bytes.subarray(0, safe.byteLength));
    expect(() => validator.push(bytes.subarray(safe.byteLength, safe.byteLength + 512))).toThrow(
      SandboxArchiveError,
    );
    // A failed validator stays failed.
    expect(() => validator.push(Buffer.alloc(512))).toThrow(SandboxArchiveError);
  });
});

function memorySpool(bytes: Uint8Array, declared = bytes): WorkspaceArchiveSpool {
  return {
    path: "",
    byteSize: declared.byteLength,
    sha256: createHash("sha256").update(declared).digest("hex"),
    async *open() {
      yield bytes;
    },
    async dispose() {},
  };
}

async function fileSpool(bytes: Uint8Array, declared = bytes): Promise<WorkspaceArchiveSpool> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-spool-test-"));
  const path = join(directory, "archive.tar");
  await writeFile(path, bytes);
  return {
    ...memorySpool(bytes, declared),
    path,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function collectingSession() {
  const received: Buffer[] = [];
  const session: WorkspaceTarStreamSession = {
    async hydrateWorkspaceTarStream(chunks) {
      for await (const chunk of chunks) received.push(Buffer.from(chunk));
    },
    async persistWorkspaceTarStream() {
      throw new Error("unused");
    },
  };
  return { session, received };
}

describe("streaming a verified spool into a session", () => {
  const archive = tar(entry("a.txt", "hello"), entry("dir/", "", { type: "5" }));
  const expected = (bytes: Uint8Array) => ({
    archiveBytes: bytes.byteLength,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const options = { rejectRelPaths: [] as string[] };

  test("forwards the exact archive", async () => {
    const spool = await fileSpool(archive);
    try {
      const { session, received } = collectingSession();
      await hydrateWorkspaceTarStreamFromSpool(session, spool, expected(archive), options);
      expect(Buffer.concat(received)).toEqual(archive);
      expect(await readWorkspaceArchiveSpool(spool)).toEqual(new Uint8Array(archive));
    } finally {
      await spool.dispose();
    }
  });

  test("a spool that changed after it was verified fails the hydration", async () => {
    const changed = Buffer.from(archive);
    changed[600] ^= 0xff;
    const spool = await fileSpool(changed, archive);
    try {
      const { session } = collectingSession();
      await expect(
        hydrateWorkspaceTarStreamFromSpool(session, spool, expected(archive), options),
      ).rejects.toThrow("does not match its descriptor");
      await expect(readWorkspaceArchiveSpool(spool)).rejects.toThrow(
        "does not match its descriptor",
      );
    } finally {
      await spool.dispose();
    }
  });

  test("a spool longer or shorter than its descriptor fails", async () => {
    for (const bytes of [Buffer.concat([archive, Buffer.alloc(512)]), archive.subarray(0, 1024)]) {
      const spool = await fileSpool(bytes, archive);
      try {
        const { session } = collectingSession();
        await expect(
          hydrateWorkspaceTarStreamFromSpool(session, spool, expected(archive), options),
        ).rejects.toBeInstanceOf(SandboxArchiveError);
        await expect(readWorkspaceArchiveSpool(spool)).rejects.toBeInstanceOf(SandboxArchiveError);
      } finally {
        await spool.dispose();
      }
    }
  });

  test("an archive writing a protected path never reaches the session", async () => {
    const unsafe = tar(entry("tmp/x", "1"));
    const spool = await fileSpool(unsafe);
    try {
      const { session, received } = collectingSession();
      await expect(
        hydrateWorkspaceTarStreamFromSpool(session, spool, expected(unsafe), {
          rejectRelPaths: ["tmp"],
        }),
      ).rejects.toBeInstanceOf(SandboxArchiveError);
      expect(received).toHaveLength(0);
    } finally {
      await spool.dispose();
    }
  });

  test("a capture is validated and spooled to disk as it streams", async () => {
    const session: WorkspaceTarStreamSession = {
      async hydrateWorkspaceTarStream() {},
      async persistWorkspaceTarStream(sink) {
        for (let offset = 0; offset < archive.byteLength; offset += 700) {
          await sink(archive.subarray(offset, offset + 700));
        }
      },
    };
    const spool = await captureWorkspaceTarStreamToSpool(session);
    try {
      expect(spool.byteSize).toBe(archive.byteLength);
      expect(spool.sha256).toBe(expected(archive).archiveSha256);
      expect(await readFile(spool.path)).toEqual(archive);
    } finally {
      await spool.dispose();
    }
    const symlinkBelow = tar(entry("l", "", { type: "2", linkname: "d" }), entry("l/x", "1"));
    await expect(
      captureWorkspaceTarStreamToSpool({
        ...session,
        async persistWorkspaceTarStream(sink) {
          await sink(symlinkBelow);
        },
      }),
    ).rejects.toBeInstanceOf(SandboxArchiveError);
  });
});

/** Modal's `Sandbox.exec` surface, running commands on this host. */
function localModalSandbox(calls: string[][]) {
  return {
    async exec(argv: string[], params: { workdir?: string; stdout?: string; mode?: string }) {
      calls.push(argv);
      const child = Bun.spawn(argv, {
        cwd: params.workdir,
        stdin: "pipe",
        stdout: params.stdout === "ignore" ? "ignore" : "pipe",
        stderr: "pipe",
      });
      const sink = child.stdin;
      return {
        stdin: new WritableStream<Uint8Array>({
          async write(chunk) {
            sink.write(chunk);
            await sink.flush();
          },
          async close() {
            await sink.end();
          },
          async abort() {
            await sink.end();
          },
        }),
        stdout: (child.stdout as ReadableStream<Uint8Array> | null) ?? ReadableStream.from([]),
        stderr: child.stderr as ReadableStream<Uint8Array>,
        async closeStdin() {
          try {
            await sink.end();
          } catch {
            // already closed
          }
        },
        wait: async () => await child.exited,
      };
    },
  };
}

function modalLikeSession(
  root: string,
  options: { ephemeral?: string[]; mounts?: string[]; calls?: string[][] } = {},
) {
  const session = {
    sandbox: localModalSandbox(options.calls ?? []),
    state: {
      environment: {},
      manifest: {
        root,
        ephemeralPersistencePaths: () => new Set(options.ephemeral ?? []),
        mountTargets: () => (options.mounts ?? []).map((mountPath) => ({ mountPath })),
      },
    },
  };
  installModalWorkspaceTarStreams(session);
  const stream = workspaceTarStreamSession(session);
  if (!stream) throw new Error("Modal session has no tar stream methods");
  return stream;
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      result[`${path}/`] = "dir";
      Object.assign(result, await tree(root, path));
    } else {
      result[path] = (await readFile(join(root, path))).toString("utf8");
    }
  }
  return result;
}

describe("Modal workspace tar streams", () => {
  test("save and restore move the workspace through the box's tar", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-modal-tar-stream-"));
    try {
      const source = join(scratch, "source");
      const target = join(scratch, "target");
      await mkdir(join(source, "src"), { recursive: true });
      await mkdir(join(source, "tmp"), { recursive: true });
      await mkdir(target);
      await writeFile(join(source, "src/index.ts"), "export const answer = 42;\n");
      await writeFile(join(source, "tmp/cache"), "ephemeral\n");
      await writeFile(join(source, "with space [x].txt"), "space\n");
      await writeFile(join(target, "stale.txt"), "removed by the restore\n");

      const spool = await captureWorkspaceTarStreamToSpool(
        modalLikeSession(source, { ephemeral: ["tmp"] }),
      );
      try {
        const calls: string[][] = [];
        await hydrateWorkspaceTarStreamFromSpool(
          modalLikeSession(target, { calls }),
          spool,
          { archiveBytes: spool.byteSize, archiveSha256: spool.sha256 },
          { rejectRelPaths: [] },
        );
        expect(await tree(target)).toEqual({
          "src/": "dir",
          "src/index.ts": "export const answer = 42;\n",
          "with space [x].txt": "space\n",
        });
        // One extraction process reading stdin; no archive file in the box.
        expect(calls).toHaveLength(1);
        expect(calls[0]![2]).toContain("-xf -");
      } finally {
        await spool.dispose();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("an ephemeral root saves the SDK's empty archive", async () => {
    const chunks: Uint8Array[] = [];
    const calls: string[][] = [];
    await modalLikeSession("/nonexistent-root", {
      ephemeral: [""],
      calls,
    }).persistWorkspaceTarStream(async (chunk) => {
      chunks.push(chunk);
    });
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(1024));
    expect(calls).toHaveLength(0);
  });

  test("refuses the filesystem root and mounts inside the workspace, like the SDK", async () => {
    const sink = async () => {};
    await expect(modalLikeSession("/").persistWorkspaceTarStream(sink)).rejects.toThrow(
      "refuses to persist a workspace tar archive at filesystem root",
    );
    await expect(
      modalLikeSession("/").hydrateWorkspaceTarStream(ReadableStream.from([])),
    ).rejects.toThrow("refuses to hydrate a workspace tar archive at filesystem root");
    await expect(
      modalLikeSession("/workspace", { mounts: ["/workspace/data"] }).persistWorkspaceTarStream(
        sink,
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test("a failed tar or a failed archive check fails the transfer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-modal-tar-failure-"));
    try {
      const notTar = (async function* () {
        yield Buffer.alloc(2048, 7);
      })();
      await expect(modalLikeSession(scratch).hydrateWorkspaceTarStream(notTar)).rejects.toThrow(
        "failed to hydrate a workspace tar archive",
      );

      await writeFile(join(scratch, "kept.txt"), "kept\n");
      const failure = new SandboxArchiveError("archive check failed", {});
      const failing = (async function* () {
        yield tar(entry("partial.txt", "partial"));
        throw failure;
      })();
      await expect(modalLikeSession(scratch).hydrateWorkspaceTarStream(failing)).rejects.toBe(
        failure,
      );

      // A sink that fails still lets the box's tar run to its end, then fails.
      const sinkFailure = new Error("disk full");
      let calls = 0;
      await expect(
        modalLikeSession(scratch).persistWorkspaceTarStream(async () => {
          calls += 1;
          throw sinkFailure;
        }),
      ).rejects.toBe(sinkFailure);
      expect(calls).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
