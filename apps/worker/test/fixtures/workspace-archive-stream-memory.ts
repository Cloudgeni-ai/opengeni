// Child process for workspace-archive-stream-memory.test.ts. One phase per
// process, so each peak is its own:
//
//   save    <scratch>  captures <scratch>/source through a real Agents SDK
//                      Modal session and publishes it to disk-backed object
//                      storage, the way a worker saves a sandbox.
//   restore <scratch>  cold-restores that archive into <scratch>/restored
//                      through the same session type, the way a worker
//                      restores one.
//
// The Modal sandbox is a fake that runs its commands on this host, so every
// byte crosses the same SDK and Opengeni code a real box's bytes cross. It
// prints how far the process's peak RSS rose during the phase.
import { createHash } from "node:crypto";
import { constants, createReadStream, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  captureWorkspaceArchiveForStorage,
  disposeWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  inlineWorkspaceArchiveForRestore,
} from "@opengeni/runtime/sandbox";
import { downloadWorkspaceArchiveSpool, type ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing/settings";
import { putVersion1TarArchiveOrInline } from "../../src/sandbox-archive-storage";

const runtimeDirectory = join(import.meta.dir, "../../../../packages/runtime");
const { ModalSandboxSession } = (await import(
  Bun.resolveSync("@openai/agents-extensions/sandbox/modal", runtimeDirectory)
)) as { ModalSandboxSession: new (args: object) => object };
const { Manifest } = (await import(
  Bun.resolveSync("@openai/agents/sandbox", runtimeDirectory)
)) as { Manifest: new (args: { root: string }) => object };
// Opengeni's Modal stream methods; absent before streaming existed, when the
// session keeps the SDK's whole-buffer tar persistence.
const installModalWorkspaceTarStreams = await import(
  join(runtimeDirectory, "src/sandbox/providers/modal-workspace-tar-stream.ts")
).then(
  (module: { installModalWorkspaceTarStreams?: (session: object) => void }) =>
    module.installModalWorkspaceTarStreams,
  () => undefined,
);

function statusKiB(field: "VmRSS" | "VmHWM"): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(
    readFileSync("/proc/self/status", "utf8"),
  );
  if (!match) throw new Error(`/proc/self/status has no ${field}`);
  return Number(match[1]);
}

function resetPeak(): void {
  // Writing 5 resets VmHWM to the current RSS, so the peak measured is this
  // phase's alone, not module loading's.
  try {
    writeFileSync("/proc/self/clear_refs", "5");
  } catch {
    // Without it the peak only over-states the growth.
  }
}

async function run(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Modal's `Sandbox` surface the SDK and Opengeni use, on this host. */
function localModalSandbox() {
  return {
    sandboxId: "sb-memory",
    async exec(
      argv: string[],
      params: { mode?: "text" | "binary"; workdir?: string; env?: Record<string, string>; stdout?: string },
    ) {
      const child = Bun.spawn(argv, {
        cwd: params.workdir,
        env: { ...process.env, ...params.env },
        stdin: "pipe",
        stdout: params.stdout === "ignore" ? "ignore" : "pipe",
        stderr: "pipe",
      });
      const text = (stream: ReadableStream<Uint8Array>) =>
        params.mode === "binary" ? stream : stream.pipeThrough(new TextDecoderStream());
      const sink = child.stdin;
      if (params.mode !== "binary") await sink.end();
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
        stdout: child.stdout ? text(child.stdout as ReadableStream<Uint8Array>) : ReadableStream.from([]),
        stderr: text(child.stderr as ReadableStream<Uint8Array>),
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
    filesystem: {
      readBytes: async (path: string) => await readFile(path),
      writeBytes: async (data: Uint8Array, path: string) => await writeFile(path, data),
    },
  };
}

function modalSession(root: string) {
  const session = new ModalSandboxSession({
    state: {
      sandboxId: "sb-memory",
      manifest: new Manifest({ root }),
      environment: {},
      workspacePersistence: "tar",
    },
    sandbox: localModalSandbox(),
  }) as Record<string, unknown>;
  // Opengeni's fingerprint probe reads the box's /workspace.
  session.exec = async ({ cmd }: { cmd: string }) =>
    await run(["sh", "-c", cmd.replace("cd /workspace\n", `cd ${root}\n`)]);
  installModalWorkspaceTarStreams?.(session);
  return session;
}

let rangeBuffer = Buffer.alloc(0);
/** Object storage backed by files under `directory`. */
function diskStorage(directory: string): ObjectStorage {
  const file = (key: string) => join(directory, createHash("sha256").update(key).digest("hex"));
  return {
    backend: "s3-compatible",
    async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
      const handle = await open(file(input.key), "w");
      try {
        for await (const chunk of input.chunks) await handle.write(chunk);
      } finally {
        await handle.close();
      }
    },
    async headObject(key: string) {
      const info = await stat(file(key)).catch(() => null);
      return info ? { ContentLength: info.size, VersionToken: "v1" } : null;
    },
    async getObjectRange(input: { key: string; start: number; endInclusive: number }) {
      const handle = await open(file(input.key), constants.O_RDONLY);
      try {
        // One reused buffer: callers consume each range before the next, and
        // the garbage of a fresh buffer per range is the storage client's
        // cost, not the archive path's under test.
        const length = input.endInclusive - input.start + 1;
        if (rangeBuffer.byteLength < length) rangeBuffer = Buffer.allocUnsafe(length);
        const bytes = rangeBuffer.subarray(0, length);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, input.start);
        return { bytes: bytes.subarray(0, bytesRead), versionToken: "v1" };
      } finally {
        await handle.close();
      }
    },
    async getObjectBytes(key: string) {
      const info = await stat(file(key)).catch(() => null);
      if (!info) return null;
      // An S3 client hands back one Buffer of the whole body.
      const parts: Buffer[] = [];
      for await (const part of createReadStream(file(key))) parts.push(part as Buffer);
      return { bytes: Buffer.concat(parts) };
    },
    async deleteObject(key: string) {
      await rm(file(key), { force: true });
    },
  } as unknown as ObjectStorage;
}

const [phase, scratch] = process.argv.slice(2);
if (!scratch || (phase !== "save" && phase !== "restore")) {
  throw new Error("usage: workspace-archive-stream-memory.ts save|restore <scratch>");
}
const storage = diskStorage(join(scratch, "objects"));
const envelopePath = join(scratch, "envelope.json");
const ids = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sandboxGroupId: "33333333-3333-4333-8333-333333333333",
};
let result: Record<string, unknown>;

if (phase === "save") {
  await mkdir(join(scratch, "objects"), { recursive: true });
  const session = modalSession(join(scratch, "source"));
  Bun.gc(true);
  resetPeak();
  const baselineKiB = statusKiB("VmRSS");
  const archive = await captureWorkspaceArchiveForStorage(
    session,
    Date.UTC(2026, 0, 1),
    { requestId: "44444444-4444-4444-8444-444444444444" },
    true,
  );
  try {
    const published = await putVersion1TarArchiveOrInline({
      backend: "modal",
      objectStorage: storage,
      ...ids,
      archive: archive as Parameters<typeof putVersion1TarArchiveOrInline>[0]["archive"],
    });
    if (!published.workspaceArchiveRef) throw new Error("save did not reach object storage");
    result = {
      peakGrowthBytes: (statusKiB("VmHWM") - baselineKiB) * 1024,
      archiveBytes: archive.descriptor.version === 1 ? archive.descriptor.archiveBytes : null,
      streamed: archive.kind === "host_spool",
    };
    await writeFile(
      envelopePath,
      JSON.stringify({
        sessionState: {
          workspaceArchiveRef: published.workspaceArchiveRef,
          workspaceArchiveMeta: archive.descriptor,
        },
      }),
    );
  } finally {
    await disposeWorkspaceArchive(archive);
  }
} else {
  const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as {
    sessionState: Record<string, unknown>;
  };
  const restoredRoot = join(scratch, "restored");
  await mkdir(restoredRoot, { recursive: true });
  await mkdir(dirname(restoredRoot), { recursive: true });
  Bun.gc(true);
  resetPeak();
  const baselineKiB = statusKiB("VmRSS");
  // The worker's own steps: inline what cold restore does not spool itself,
  // then establish the box with the verified-spool loader.
  const sessionState = await inlineWorkspaceArchiveForRestore(
    envelope.sessionState,
    async (key) => await storage.getObjectBytes(key),
  );
  const restored = await establishSandboxSessionFromEnvelope(
    testSettings({ sandboxBackend: "modal" }),
    { sessionState },
    {
      sessionId: "workspace-archive-stream-memory",
      recovery: "create-or-restore",
      backendOverride: "modal",
      environment: {},
      clientFactory: (() => ({
        backendId: "modal",
        async create() {
          return modalSession(restoredRoot);
        },
        async delete() {},
      })) as never,
      loadHostWorkspaceArchive: async (ref) =>
        await downloadWorkspaceArchiveSpool(storage, ref.key, {
          bytes: ref.bytes,
          sha256: ref.sha256,
        }),
    },
  );
  if (restored.origin !== "restored") throw new Error(`restore origin was ${restored.origin}`);
  result = { peakGrowthBytes: (statusKiB("VmHWM") - baselineKiB) * 1024 };
}
console.log(JSON.stringify(result));
