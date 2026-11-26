import { posix } from "node:path";
import { SandboxArchiveError, SandboxUnsupportedFeatureError } from "@openai/agents/sandbox";
import { shellQuoteTarArg, workspaceTarExcludeArgs } from "../workspace-tar-excludes";
import type { WorkspaceTarStreamSession } from "../workspace-tar-stream";

const PROVIDER_NAME = "ModalSandboxClient";
/** Modal's own `filesystem.writeBytes` sends stdin in chunks of this size. */
const STDIN_WRITE_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
/** Two zero blocks: the SDK's archive when the whole root is ephemeral. */
const EMPTY_TAR_BYTES = 1024;

type ModalStreamProcess = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  closeStdin?: () => Promise<void>;
  wait: () => Promise<number>;
};

type ModalStreamSandbox = {
  exec: (
    command: string[],
    params: {
      mode: "binary";
      workdir: string;
      env?: Record<string, string>;
      stdout: "pipe" | "ignore";
      stderr: "pipe";
    },
  ) => Promise<ModalStreamProcess>;
};

type ModalTarStreamTarget = {
  sandbox?: Partial<ModalStreamSandbox>;
  state?: {
    environment?: Record<string, string>;
    manifest?: {
      root?: unknown;
      ephemeralPersistencePaths?: () => Iterable<unknown>;
      mountTargets?: () => Array<{ mountPath?: unknown }>;
    };
  };
  resolveRemotePath?: (path: string, options?: { forWrite?: boolean }) => Promise<unknown>;
  hydrateWorkspaceTarStream?: WorkspaceTarStreamSession["hydrateWorkspaceTarStream"];
  persistWorkspaceTarStream?: WorkspaceTarStreamSession["persistWorkspaceTarStream"];
};

/**
 * Gives a Modal session the streamed form of the SDK's tar persistence
 * (`persistRemoteWorkspaceTar` / `hydrateRemoteWorkspaceTar`). The SDK writes
 * the whole archive to a file in the box and moves it with one
 * `filesystem.readBytes` / `writeBytes` buffer, so a large workspace costs the
 * worker several copies of it. Here one process in the box (`tar -c` to
 * stdout, `tar -x` from stdin) moves it through Modal's exec streams in small
 * chunks; the box needs no network access or storage credentials, and no
 * archive file is left in it.
 *
 * The commands, exclusions, root and mount checks are the SDK's. The archive's
 * member checks run in the caller (`WorkspaceTarStreamValidator`) on every
 * chunk before it reaches `tar -x`.
 */
export function installModalWorkspaceTarStreams(session: object): void {
  const target = session as ModalTarStreamTarget;
  target.persistWorkspaceTarStream = async (sink) => await persistModalWorkspaceTar(target, sink);
  target.hydrateWorkspaceTarStream = async (chunks) =>
    await hydrateModalWorkspaceTar(target, chunks);
}

async function persistModalWorkspaceTar(
  session: ModalTarStreamTarget,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const { sandbox, root, protectedPaths } = await modalTarContext(session, "persist");
  if (protectedPaths.includes("")) {
    await sink(new Uint8Array(EMPTY_TAR_BYTES));
    return;
  }
  const command = [
    `mkdir -p -- ${shellQuoteTarArg(root)}`,
    [
      "tar",
      ...workspaceTarExcludeArgs(protectedPaths),
      // Files sharing an inode (a package manager's cache hardlinked into
      // node_modules) become separate regular members, as in every other
      // backend's archive and the workspace fingerprint. Without it GNU tar
      // writes hardlink members, which the archive check refuses, so such a
      // workspace could never be saved.
      "--hard-dereference",
      "-C",
      shellQuoteTarArg(root),
      "-cf",
      "-",
      ".",
    ].join(" "),
  ].join(" && ");
  const process = await sandbox.exec(["/bin/sh", "-c", command], {
    mode: "binary",
    workdir: root,
    ...(session.state?.environment ? { env: session.state.environment } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = streamTail(process.stderr);
  let sinkFailure: { error: unknown } | undefined;
  for await (const chunk of process.stdout) {
    // After a failed write keep reading: the capture ends only when the tar
    // in the box has exited, so a retry never runs next to it.
    if (sinkFailure) continue;
    try {
      await sink(chunk);
    } catch (error) {
      sinkFailure = { error };
    }
  }
  const exitCode = await process.wait();
  const stderrTail = await stderr;
  if (sinkFailure) throw sinkFailure.error;
  if (exitCode !== 0) {
    throw new SandboxArchiveError(`${PROVIDER_NAME} failed to create a workspace tar archive.`, {
      provider: PROVIDER_NAME,
      root,
      exitCode,
      stderr: stderrTail,
    });
  }
}

async function hydrateModalWorkspaceTar(
  session: ModalTarStreamTarget,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  const { sandbox, root } = await modalTarContext(session, "hydrate");
  const quotedRoot = shellQuoteTarArg(root);
  const command = [
    `mkdir -p -- ${quotedRoot}`,
    `find ${quotedRoot} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    `tar -C ${quotedRoot} -xf -`,
  ].join(" && ");
  const process = await sandbox.exec(["/bin/sh", "-c", command], {
    mode: "binary",
    workdir: root,
    ...(session.state?.environment ? { env: session.state.environment } : {}),
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = streamTail(process.stderr);
  const writer = process.stdin.getWriter();
  let sourceFailure: { error: unknown } | undefined;
  let writeFailure: { error: unknown } | undefined;
  try {
    // Chunks are copied into one write buffer as they arrive, so Modal gets
    // few, full-size writes. Each write is awaited before the buffer is
    // refilled: Modal sends the bytes in that write's request.
    const buffer = Buffer.allocUnsafe(STDIN_WRITE_BYTES);
    let used = 0;
    const flush = async () => {
      if (used === 0) return;
      const data = buffer.subarray(0, used);
      used = 0;
      try {
        await writer.write(data);
      } catch (error) {
        writeFailure = { error };
        throw error;
      }
    };
    const iterator = chunks[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        next = await iterator.next();
      } catch (error) {
        sourceFailure = { error };
        throw error;
      }
      if (next.done) break;
      const chunk = next.value;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const length = Math.min(chunk.byteLength - offset, buffer.byteLength - used);
        buffer.set(chunk.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === buffer.byteLength) await flush();
      }
    }
    await flush();
    try {
      await writer.close();
    } catch (error) {
      writeFailure = { error };
      throw error;
    }
  } catch {
    // Stop the extractor's input either way, then wait for it to exit so a
    // failed hydration never leaves a tar running in the box.
    await writer.abort(sourceFailure?.error ?? writeFailure?.error).catch(() => undefined);
    await process.closeStdin?.().catch(() => undefined);
  } finally {
    writer.releaseLock();
  }
  const exitCode = await process.wait();
  const stderrTail = await stderr;
  // The archive's own check failed (unsafe member, size or hash mismatch):
  // that is the reason, whatever the extractor made of the cut-off input.
  if (sourceFailure) throw sourceFailure.error;
  if (exitCode !== 0) {
    throw new SandboxArchiveError(`${PROVIDER_NAME} failed to hydrate a workspace tar archive.`, {
      provider: PROVIDER_NAME,
      root,
      exitCode,
      stderr: stderrTail,
    });
  }
  if (writeFailure) {
    const { error } = writeFailure;
    throw Object.assign(
      new SandboxArchiveError(`${PROVIDER_NAME} failed to hydrate the workspace archive.`, {
        provider: PROVIDER_NAME,
        root,
        cause: error instanceof Error ? error.message : String(error),
      }),
      { cause: error },
    );
  }
}

/** The SDK's preconditions for a remote workspace tar: never the filesystem
 * root, no Modal mount inside the workspace, and the root itself validated
 * for writing. Read at call time: a filesystem-snapshot restore replaces the
 * session's sandbox object. */
async function modalTarContext(
  session: ModalTarStreamTarget,
  operation: "persist" | "hydrate",
): Promise<{ sandbox: ModalStreamSandbox; root: string; protectedPaths: string[] }> {
  const manifest = session.state?.manifest;
  const root = manifest?.root;
  const sandbox = session.sandbox;
  if (typeof root !== "string" || typeof sandbox?.exec !== "function") {
    throw new SandboxArchiveError(
      `${PROVIDER_NAME} has no sandbox to ${operation} a workspace tar.`,
      {
        provider: PROVIDER_NAME,
      },
    );
  }
  if (root === "/") {
    throw new SandboxArchiveError(
      `${PROVIDER_NAME} refuses to ${operation} a workspace tar archive at filesystem root.`,
      { provider: PROVIDER_NAME, root },
    );
  }
  const normalizedRoot = posix.normalize(root).replace(/\/+$/u, "");
  const mountPaths = [
    ...new Set(
      (manifest?.mountTargets?.() ?? [])
        .map(({ mountPath }) => mountPath)
        .filter((path): path is string => typeof path === "string")
        .map((path) => posix.normalize(path).replace(/\/+$/u, ""))
        .filter((path) => path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (mountPaths.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${PROVIDER_NAME} cannot use tar workspace persistence with mount entries under the workspace root.`,
      { provider: "modal", feature: "workspacePersistence.tar", root, mountPaths },
    );
  }
  await session.resolveRemotePath?.(root, { forWrite: true });
  const protectedPaths = [...(manifest?.ephemeralPersistencePaths?.() ?? [])]
    .filter((path): path is string => typeof path === "string")
    .sort((left, right) => left.localeCompare(right));
  return { sandbox: sandbox as ModalStreamSandbox, root, protectedPaths };
}

/** Reads a stream to its end, keeping only its last few KiB as text. */
async function streamTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      tail = Buffer.concat([tail, chunk]);
      if (tail.byteLength > STDERR_TAIL_BYTES) tail = tail.subarray(-STDERR_TAIL_BYTES);
    }
  } catch {
    // stderr is diagnostic only; the exit code decides.
  }
  return tail.toString("utf8");
}
