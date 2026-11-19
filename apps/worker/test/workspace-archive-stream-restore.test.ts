// A remote sandbox's workspace tar in object storage is downloaded into a
// verified disk spool and streamed into the new box. Its size and SHA-256
// must match the descriptor before any box is created, the bytes streamed
// are checked again, and any mismatch fails closed: no box is kept and
// nothing is marked restored.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceArchiveObjectRef } from "@opengeni/contracts";
import {
  captureWorkspaceArchiveForStorage,
  disposeWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
} from "@opengeni/runtime/sandbox";
import { downloadWorkspaceArchiveSpool, type ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing/settings";
import { installModalWorkspaceTarStreams } from "../../../packages/runtime/src/sandbox/providers/modal-workspace-tar-stream";
import { putVersion1TarArchiveOrInline } from "../src/sandbox-archive-storage";

async function run(argv: string[], stdin?: Uint8Array) {
  const child = Bun.spawn(argv, {
    stdin: stdin ? new Blob([stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A Modal-shaped session whose box is a directory on this host. */
function remoteSession(root: string, options: { streams?: boolean } = {}) {
  const session: Record<string, unknown> = {
    state: {
      sandboxId: "sb-stream",
      environment: {},
      manifest: { root, ephemeralPersistencePaths: () => new Set<string>() },
    },
    sandbox: {
      async exec(argv: string[], params: { workdir?: string; stdout?: string }) {
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
    },
    // Opengeni's fingerprint probe reads the box's /workspace.
    async exec({ cmd }: { cmd: string }) {
      return await run(["sh", "-c", cmd.replace("cd /workspace\n", `cd ${root}\n`)]);
    },
    // The whole-buffer path, for a session without stream methods.
    async hydrateWorkspace(data: Uint8Array) {
      hydrateWorkspaceCalls += 1;
      const result = await run(["tar", "-C", root, "-xf", "-"], data);
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
  };
  if (options.streams !== false) installModalWorkspaceTarStreams(session);
  return session;
}

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  let wholeObjectReads = 0;
  const storage = {
    backend: "s3-compatible",
    async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
      const parts: Buffer[] = [];
      for await (const chunk of input.chunks) parts.push(Buffer.from(chunk));
      objects.set(input.key, Buffer.concat(parts));
    },
    async headObject(key: string) {
      const object = objects.get(key);
      return object ? { ContentLength: object.length, VersionToken: "v1" } : null;
    },
    async getObjectRange(input: { key: string; start: number; endInclusive: number }) {
      const object = objects.get(input.key);
      return object
        ? { bytes: object.subarray(input.start, input.endInclusive + 1), versionToken: "v1" }
        : null;
    },
    async getObjectBytes() {
      wholeObjectReads += 1;
      throw new Error("a workspace tar must not be fetched whole");
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
  };
  return {
    storage: storage as unknown as ObjectStorage,
    objects,
    wholeObjectReads: () => wholeObjectReads,
  };
}

let scratch: string;
let hydrateWorkspaceCalls = 0;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "opengeni-stream-restore-"));
  hydrateWorkspaceCalls = 0;
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function savedWorkspace() {
  const source = join(scratch, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "README.md"), "# Project\n");
  await writeFile(join(source, "src/index.ts"), "export const answer = 42;\n");
  const archive = await captureWorkspaceArchiveForStorage(
    remoteSession(source),
    Date.UTC(2026, 0, 1),
    { requestId: "44444444-4444-4444-8444-444444444444" },
    true,
  );
  expect(archive.kind).toBe("host_spool");
  const memory = memoryStorage();
  try {
    const published = await putVersion1TarArchiveOrInline({
      backend: "modal",
      objectStorage: memory.storage,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sandboxGroupId: "33333333-3333-4333-8333-333333333333",
      archive: archive as Parameters<typeof putVersion1TarArchiveOrInline>[0]["archive"],
    });
    return {
      ...memory,
      ref: published.workspaceArchiveRef!,
      descriptor: archive.descriptor,
    };
  } finally {
    await disposeWorkspaceArchive(archive);
  }
}

async function restore(
  saved: Awaited<ReturnType<typeof savedWorkspace>>,
  options: {
    ref?: WorkspaceArchiveObjectRef;
    streams?: boolean;
    afterDownload?: (path: string) => Promise<void>;
  } = {},
) {
  const target = join(scratch, "target");
  await mkdir(target, { recursive: true });
  const events = { creates: 0, deletes: 0 };
  const restored = await establishSandboxSessionFromEnvelope(
    testSettings({ sandboxBackend: "modal" }),
    {
      sessionState: {
        workspaceArchiveRef: options.ref ?? saved.ref,
        workspaceArchiveMeta: saved.descriptor,
      },
    },
    {
      sessionId: "stream-restore",
      recovery: "create-or-restore",
      backendOverride: "modal",
      environment: {},
      clientFactory: (() => ({
        backendId: "modal",
        async create() {
          events.creates += 1;
          return remoteSession(target, { streams: options.streams });
        },
        async delete() {
          events.deletes += 1;
        },
      })) as never,
      loadHostWorkspaceArchive: async (ref) => {
        const spool = await downloadWorkspaceArchiveSpool(saved.storage, ref.key, {
          bytes: ref.bytes,
          sha256: ref.sha256,
        });
        await options.afterDownload?.(spool.path);
        return spool;
      },
    },
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { ...restored, events, target };
}

test.skipIf(process.platform !== "linux")(
  "a portable tar streams from object storage into the new box and verifies",
  async () => {
    const saved = await savedWorkspace();
    const { value, error, events, target } = await restore(saved);
    expect(error).toBeUndefined();
    expect(value?.origin).toBe("restored");
    expect(value?.restoredArchive?.revision).toBe(saved.descriptor.revision);
    expect(events).toEqual({ creates: 1, deletes: 0 });
    expect(hydrateWorkspaceCalls).toBe(0);
    expect(saved.wholeObjectReads()).toBe(0);
    expect((await readdir(target)).sort()).toEqual(["README.md", "src"]);
    expect(await readFile(join(target, "src/index.ts"), "utf8")).toBe(
      "export const answer = 42;\n",
    );
  },
);

test.skipIf(process.platform !== "linux")(
  "a session without stream methods hydrates the verified bytes",
  async () => {
    const saved = await savedWorkspace();
    const { value, error, target } = await restore(saved, { streams: false });
    expect(error).toBeUndefined();
    expect(value?.origin).toBe("restored");
    expect(hydrateWorkspaceCalls).toBe(1);
    expect((await readdir(target)).sort()).toEqual(["README.md", "src"]);
  },
);

test.skipIf(process.platform !== "linux")(
  "a corrupted object fails closed before any box is created",
  async () => {
    const saved = await savedWorkspace();
    const object = saved.objects.get(saved.ref.key)!;
    object[700] ^= 0xff;
    const { value, error, events } = await restore(saved);
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: "archive_hash_mismatch" });
    expect(events.creates).toBe(0);
  },
);

test.skipIf(process.platform !== "linux")(
  "a truncated object fails closed before any box is created",
  async () => {
    const saved = await savedWorkspace();
    const object = saved.objects.get(saved.ref.key)!;
    saved.objects.set(saved.ref.key, object.subarray(0, object.length - 512));
    const { value, error, events } = await restore(saved);
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: "archive_hash_mismatch" });
    expect(events.creates).toBe(0);
  },
);

test.skipIf(process.platform !== "linux")(
  "a reference that disagrees with its descriptor fails closed before any box is created",
  async () => {
    const saved = await savedWorkspace();
    const { value, error, events } = await restore(saved, {
      ref: { ...saved.ref, sha256: "0".repeat(64) },
    });
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: "archive_hash_mismatch" });
    expect(events.creates).toBe(0);
  },
);

test.skipIf(process.platform !== "linux")(
  "an archive that changes after its download was verified is never marked restored",
  async () => {
    const saved = await savedWorkspace();
    const { value, error, events } = await restore(saved, {
      afterDownload: async (path) => {
        const bytes = await readFile(path);
        bytes[700] ^= 0xff;
        await writeFile(path, bytes);
      },
    });
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: "archive_hydration_failed" });
    expect(events).toEqual({ creates: 1, deletes: 1 });
  },
);
