import { execFile } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { chmod, lstat, readdir, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { DockerSandboxSession, type DockerSandboxClient } from "@openai/agents/sandbox/local";
import type { SandboxArchiveLimits } from "@openai/agents/sandbox";
import {
  captureHostWorkspaceArchive,
  readHostWorkspaceRootIdentity,
  type HostWorkspaceRootIdentity,
} from "../host-archive-spool";
import { SandboxConfigError } from "../errors";

const execFileAsync = promisify(execFile);
type NativeProbe = (
  args: readonly string[],
  timeout: number,
) => Promise<{ stdout: string; stderr: string }>;
const nativeProbe: NativeProbe = async (args, timeout) =>
  await execFileAsync("docker", [...args], { timeout, maxBuffer: 1024 * 1024 });
const FIELD = "opengeniDockerWorkspaceOwnership";
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
type State = Parameters<DockerSandboxClient["resume"]>[0];
type Ownership = {
  version: 1;
  containerId: string;
  sessionIdentity: string;
  daemonId: string;
  mountFingerprint: string;
  root: string;
  sourceRoot: string;
  identity: HostWorkspaceRootIdentity;
};
const receipts = new WeakMap<object, Ownership>();
const ownedSdkStates = new WeakSet<object>();

/** Internal SDK producer identity, not caller metadata or a filesystem grant. */
export function rememberOwnedDockerSdkState(state: State): void {
  ownedSdkStates.add(state);
}

function invalid(message: string): never {
  throw new SandboxConfigError("docker", "Docker drain workspace authority: " + message);
}

function shape(state: State) {
  if (
    !ID.test(state.containerId) ||
    !UUID.test(state.sessionIdentity ?? "") ||
    state.workspaceRootOwned !== true ||
    !isAbsolute(state.workspaceRootPath) ||
    resolve(state.workspaceRootPath) !== state.workspaceRootPath ||
    state.workspaceRootPath === "/" ||
    (state.snapshot !== null && state.snapshot !== undefined)
  )
    invalid("owned SDK state is unavailable");
  return {
    containerId: state.containerId,
    sessionIdentity: state.sessionIdentity!,
    root: state.workspaceRootPath,
  };
}

function parsedReceipt(value: unknown, state: State): Ownership | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Ownership;
  const s = shape(state);
  if (
    v.version !== 1 ||
    v.containerId !== s.containerId ||
    v.sessionIdentity !== s.sessionIdentity ||
    v.sourceRoot !== s.root ||
    typeof v.root !== "string" ||
    !isAbsolute(v.root) ||
    resolve(v.root) !== v.root ||
    v.root === "/" ||
    typeof v.daemonId !== "string" ||
    !/^[A-Za-z0-9:_.-]{1,200}$/.test(v.daemonId) ||
    !SHA.test(v.mountFingerprint) ||
    !v.identity ||
    typeof v.identity !== "object" ||
    !["dev", "ino", "uid", "gid", "mode"].every(
      (key) =>
        typeof v.identity[key as keyof HostWorkspaceRootIdentity] === "string" &&
        /^(?:0|[1-9][0-9]*)$/.test(v.identity[key as keyof HostWorkspaceRootIdentity]),
    )
  )
    invalid("protected ownership receipt differs");
  return Object.freeze({ ...v, identity: Object.freeze({ ...v.identity }) });
}

/** Called only for the protected provider-state envelope deserialized by the
 * server lifecycle. This receipt is evidence, not authorization: drain must
 * independently pass the current scoped lease/epoch/capture fence. */
export function rememberSerializedDockerOwnership(state: State, serialized: unknown): void {
  const value =
    serialized && typeof serialized === "object" ? Reflect.get(serialized, FIELD) : undefined;
  if (value !== undefined) {
    if (
      !serialized ||
      typeof serialized !== "object" ||
      Reflect.get(serialized, "workspaceRootOwned") !== true ||
      Reflect.get(serialized, "containerId") !== state.containerId ||
      Reflect.get(serialized, "sessionIdentity") !== state.sessionIdentity ||
      Reflect.get(serialized, "workspaceRootPath") !== state.workspaceRootPath
    )
      invalid("protected SDK producer state differs");
    const receipt = parsedReceipt(value, state);
    if (!receipt) invalid("protected ownership receipt is invalid");
    receipts.set(state, receipt);
  }
}

type Observation = {
  id: string;
  running: boolean;
  labels: Record<string, string>;
  mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }>;
};

async function daemon(probe: NativeProbe): Promise<string> {
  const result = await probe(["info", "--format", "{{.ID}}"], 10_000);
  const id = result.stdout.trim();
  if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(id) || result.stderr.trim())
    invalid("native daemon observation failed");
  return id;
}

async function observe(containerId: string, probe: NativeProbe): Promise<Observation | null> {
  try {
    const result = await probe(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        '{"id":{{json .Id}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}',
        containerId,
      ],
      10_000,
    );
    if (result.stderr.trim()) invalid("native container observation failed");
    const value = JSON.parse(result.stdout) as Observation;
    if (
      value.id !== containerId ||
      typeof value.running !== "boolean" ||
      !value.labels ||
      !Array.isArray(value.mounts)
    )
      invalid("native container identity differs");
    return value;
  } catch (error) {
    const stderr = error && typeof error === "object" ? Reflect.get(error, "stderr") : null;
    if (
      typeof stderr === "string" &&
      Reflect.get(error as object, "code") === 1 &&
      !Reflect.get(error as object, "signal") &&
      !Reflect.get(error as object, "killed") &&
      new RegExp(
        "^(?:Error|Error response from daemon): No such (?:object|container): " + containerId + "$",
      ).test(stderr.trim())
    )
      return null;
    throw error;
  }
}

async function ownedMount(
  observation: Observation,
  state: State,
  receipt?: Ownership,
): Promise<{ fingerprint: string; root: string }> {
  const s = shape(state);
  const fingerprint = observation.labels["openai-agents-sandbox.mount-authority-fingerprint"];
  if (
    observation.labels["openai-agents-sandbox"] !== "true" ||
    observation.labels["openai-agents-sandbox.session-identity"] !== s.sessionIdentity ||
    !SHA.test(fingerprint ?? "") ||
    (receipt && fingerprint !== receipt.mountFingerprint)
  )
    invalid("native SDK mount ownership differs");
  // The SDK records an actual canonical bind source. Preserve that authority,
  // including platform-owned aliases such as macOS /var -> /private/var;
  // content access always uses the recorded canonical source, never the alias.
  const root = await realpath(s.root);
  if (
    (receipt && root !== receipt.root) ||
    !observation.mounts.some(
      (m) =>
        m.Type === "bind" &&
        m.Source === root &&
        m.Destination === state.manifest.root &&
        m.RW === true,
    )
  )
    invalid("native SDK mount ownership differs");
  return { fingerprint: fingerprint!, root };
}

/** Mint only for a returned SDK producer state or an authenticated exact-live
 * attachment. SDK native reuse validation checks the complete mount authority
 * fingerprint, including inode identity; names and caller shapes do not mint. */
export async function serializeDockerOwnership(
  client: DockerSandboxClient,
  state: State,
  probe: NativeProbe = nativeProbe,
): Promise<Record<string, unknown>> {
  if (!ownedSdkStates.has(state)) return {};
  const s = shape(state);
  const daemonId = await daemon(probe);
  const native = await observe(s.containerId, probe);
  if (!native?.running) invalid("live SDK ownership could not be verified");
  const mount = await ownedMount(native, state);
  const identity = await readHostWorkspaceRootIdentity(mount.root);
  if (!(await client.canReusePreservedOwnedSession(state)))
    invalid("live SDK ownership could not be verified");
  await readHostWorkspaceRootIdentity(mount.root, identity);
  if ((await daemon(probe)) !== daemonId) invalid("native daemon identity changed");
  const receipt = Object.freeze({
    version: 1 as const,
    containerId: s.containerId,
    sessionIdentity: s.sessionIdentity,
    sourceRoot: s.root,
    root: mount.root,
    daemonId,
    mountFingerprint: mount.fingerprint,
    identity,
  });
  receipts.set(state, receipt);
  return { [FIELD]: receipt };
}

/** What happened to the drained host workspace directory after exact
 * container teardown. `retained` is never an error for the drain: the archive
 * is already durably published, so the lease still goes cold. */
export type DockerHostWorkspaceRelease =
  | { status: "released" }
  | { status: "already_released" }
  | { status: "retained"; reason: string };

export type DockerWorkspaceDrainCapture = {
  state: { workspaceRootPath: string; manifest: State["manifest"] };
  workspaceCaptureRootIdentity: HostWorkspaceRootIdentity;
  assertWorkspaceCaptureAuthority: () => Promise<void>;
  persistWorkspace: () => Promise<Uint8Array>;
  delete: () => Promise<void>;
  /** Set by `delete()`; null until teardown ran. */
  readonly hostWorkspaceRelease: DockerHostWorkspaceRelease | null;
};

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** True only when both the recorded SDK path and its canonical receipt root
 * are definitively absent. Any other failure keeps the ordinary fence. */
async function rootIsAbsent(sourceRoot: string, canonicalRoot: string): Promise<boolean> {
  for (const path of [sourceRoot, canonicalRoot]) {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return false;
    }
  }
  return true;
}

/** Grants the owner u+rwx on every real descendant directory so read-only
 * trees (the Go module cache is written 0555) can be unlinked. Symlinks are
 * never followed or chmodded, and the root itself is left untouched so its
 * receipt identity (which includes the mode) still authenticates a retry. */
async function makeDescendantsRemovable(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (!stats.isDirectory()) continue;
      if ((stats.mode & 0o700) !== 0o700) await chmod(path, (stats.mode & 0o7777) | 0o700);
      pending.push(path);
    }
  }
}

async function removeOwnedTree(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await makeDescendantsRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}

/** Capture-only attachment: no SDK resume/create, exec, viewer, hydration or
 * close capability. Its root comes from the protected SDK receipt and the
 * current scoped capture fence, never from a path/ownership flag alone. */
export async function attachDockerWorkspaceForDrain(
  client: DockerSandboxClient,
  state: State,
  assertCurrentCapture: () => Promise<{ archivePublished: boolean }>,
  probe: NativeProbe = nativeProbe,
  archiveLimits?: SandboxArchiveLimits | null,
): Promise<DockerWorkspaceDrainCapture> {
  await assertCurrentCapture();
  const s = shape(state);
  let receipt = receipts.get(state);
  if (!receipt) {
    const native = await observe(s.containerId, probe);
    // Legacy stopped/missing state has no independent inode/owner receipt.
    // Preserve its data and lease; neither NotFound nor siblings grant custody.
    if (!native?.running) invalid("legacy stopped/missing workspace has no owned-root receipt");
    await ownedMount(native, state);
    if (!(await client.canReusePreservedOwnedSession(state)))
      invalid("live SDK ownership could not be verified");
    rememberOwnedDockerSdkState(state);
    await serializeDockerOwnership(client, state, probe);
    receipt = receipts.get(state)!;
  }
  const granted = receipt;
  if (await rootIsAbsent(s.root, granted.root)) {
    // A previous attempt of this same published drain already tore the
    // container down and released the host workspace, then died before the
    // cold commit. Only that exact state may skip the root fence: the archive
    // is durably published (so no re-arm or continuity can claim this root),
    // the daemon is unchanged and the exact container is gone.
    const assertReleased = async () => {
      if (!(await assertCurrentCapture()).archivePublished)
        invalid("recorded SDK root is missing before durable publication");
      if ((await daemon(probe)) !== granted.daemonId) invalid("native daemon identity changed");
      if (await observe(s.containerId, probe))
        invalid("recorded SDK root is missing while its exact container exists");
    };
    await assertReleased();
    let release: DockerHostWorkspaceRelease | null = null;
    const released = () => invalid("host workspace was already released after publication");
    return {
      state: { workspaceRootPath: granted.root, manifest: state.manifest },
      workspaceCaptureRootIdentity: granted.identity,
      assertWorkspaceCaptureAuthority: async () => released(),
      persistWorkspace: async () => released(),
      async delete() {
        await assertReleased();
        release = { status: "already_released" };
      },
      get hostWorkspaceRelease() {
        return release;
      },
    };
  }
  const assertAuthority = async () => {
    await assertCurrentCapture();
    if ((await daemon(probe)) !== granted.daemonId) invalid("native daemon identity changed");
    const native = await observe(s.containerId, probe);
    if ((await realpath(s.root)) !== granted.root) invalid("recorded SDK root changed");
    if (native) await ownedMount(native, state, granted);
    await readHostWorkspaceRootIdentity(granted.root, granted.identity);
  };
  /** Best effort and never throws: the archive is already durable, and a
   * throw here would keep the lease draining with a released container. */
  const releaseHostWorkspace = async (): Promise<DockerHostWorkspaceRelease> => {
    try {
      // Re-prove every fence immediately before removal: the same published
      // capture, the same daemon, the exact container gone (nothing can write
      // or re-attach through it), and the recorded canonical root still the
      // receipt's inode/owner/mode. The cold commit that follows is
      // archive-only and never keeps docker continuity for this root.
      if (!(await assertCurrentCapture()).archivePublished)
        return {
          status: "retained",
          reason: "capture is no longer durably published",
        };
      if ((await daemon(probe)) !== granted.daemonId)
        return {
          status: "retained",
          reason: "native daemon identity changed",
        };
      if (await observe(s.containerId, probe))
        return { status: "retained", reason: "exact container still exists" };
      if ((await realpath(s.root)) !== granted.root)
        return { status: "retained", reason: "recorded SDK root changed" };
      await readHostWorkspaceRootIdentity(granted.root, granted.identity);
      await removeOwnedTree(granted.root);
      return { status: "released" };
    } catch (error) {
      return { status: "retained", reason: reasonOf(error) };
    }
  };
  let release: DockerHostWorkspaceRelease | null = null;
  await assertAuthority();
  return {
    state: { workspaceRootPath: granted.root, manifest: state.manifest },
    workspaceCaptureRootIdentity: granted.identity,
    assertWorkspaceCaptureAuthority: assertAuthority,
    async persistWorkspace() {
      await assertAuthority();
      if (process.platform !== "linux") {
        // Preserve the SDK's existing non-Linux archive format/limits. The
        // borrowed object remains private and exposes no execution or close.
        const borrowed = new DockerSandboxSession({
          state: { ...state, workspaceRootPath: granted.root },
          ...(archiveLimits !== undefined ? { archiveLimits } : {}),
        });
        const bytes = await borrowed.persistWorkspace();
        await assertAuthority();
        return bytes;
      }
      const archive = await captureHostWorkspaceArchive(
        granted.root,
        [...state.manifest.ephemeralPersistencePaths()],
        granted.identity,
      );
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of archive.spool.open()) chunks.push(chunk);
        return Buffer.concat(chunks);
      } finally {
        await archive.spool.dispose();
      }
    },
    async delete() {
      if (!(await assertCurrentCapture()).archivePublished)
        invalid("exact capture is not durably published");
      await assertAuthority();
      if (await observe(s.containerId, probe)) {
        // Exact-container teardown, without SDK close (which would also remove
        // unrelated volumes and skips every fence below).
        const result = await probe(["rm", "-f", s.containerId], 30_000);
        if (result.stderr.trim() || result.stdout.trim() !== s.containerId)
          invalid("exact-container teardown outcome is unknown");
      }
      // Once the published capture's container is gone, nothing references
      // this host workspace: the lease can only commit cold from an archive.
      release = await releaseHostWorkspace();
    },
    get hostWorkspaceRelease() {
      return release;
    },
  };
}
