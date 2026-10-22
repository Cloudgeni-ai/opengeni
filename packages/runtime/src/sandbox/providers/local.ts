import {
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
  type UnixLocalSandboxClientOptions,
  type UnixLocalSandboxSessionState,
} from "@openai/agents/sandbox/local";
import { NoopSnapshotSpec } from "@openai/agents/sandbox";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { installDurableShellProcesses } from "../durable-shell-process";
import { SandboxConfigError, SandboxExactResumeInstanceUnavailableError } from "../errors";
import { REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

function isMissingLocalWorkspaceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

class OpenGeniUnixLocalSandboxClient extends UnixLocalSandboxClient {
  readonly #openGeniOptions: UnixLocalSandboxClientOptions;

  constructor(options: UnixLocalSandboxClientOptions = {}) {
    super(options);
    this.#openGeniOptions = options;
  }

  // Commands run under a supervisor in the workspace's own namespace, so any
  // session object for this workspace (another turn, worker or the reaper)
  // reaches them, not only the object that started them.
  override async create(...args: Parameters<UnixLocalSandboxClient["create"]>) {
    return installDurableShellProcesses(await super.create(...args), "local");
  }

  override async resume(...args: Parameters<UnixLocalSandboxClient["resume"]>) {
    return installDurableShellProcesses(await super.resume(...args), "local");
  }

  /** The SDK's ordinary resume may restore an older snapshot, including into a
   * newly-created temporary directory. Exact attachment only re-opens the live
   * workspace path and therefore never writes or creates provider state. */
  async resumeExact(
    state: UnixLocalSandboxSessionState,
    options: Parameters<UnixLocalSandboxClient["resume"]>[1] = {},
  ): Promise<UnixLocalSandboxSession> {
    if (!isAbsolute(state.workspaceRootPath)) {
      throw new SandboxConfigError("local", "persisted local workspace path is invalid");
    }
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(state.workspaceRootPath);
    } catch (error) {
      if (isMissingLocalWorkspaceError(error)) {
        throw new SandboxExactResumeInstanceUnavailableError("local", state.workspaceRootPath);
      }
      throw error;
    }
    // A workspace created by this client is a real directory. Following a
    // replacement symlink would silently rebind the persisted identity.
    if (!entry.isDirectory()) {
      throw new SandboxExactResumeInstanceUnavailableError("local", state.workspaceRootPath);
    }
    const archiveLimits =
      options?.archiveLimits === undefined
        ? this.#openGeniOptions.archiveLimits
        : options.archiveLimits;
    return installDurableShellProcesses(
      new UnixLocalSandboxSession({
        state,
        ...(this.#openGeniOptions.defaultShell !== undefined
          ? { defaultShell: this.#openGeniOptions.defaultShell }
          : {}),
        ...(archiveLimits !== undefined ? { archiveLimits } : {}),
      }),
      "local",
    );
  }
}

export const localProvider: ProviderRegistration = {
  backend: "local",
  exactResumeMode: "custom",
  instanceIdFields: ["workspaceRootPath"],
  workspaceCapturePolicy: () => REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.local,
  // UnixLocalSandboxClient runs in-process — no credentials, no options.
  validateCredentials() {},
  build() {
    // The durable Opengeni archive ledger owns restoration. A process-local SDK
    // snapshot is neither portable nor independently governed and can be older
    // than the still-live workspace path.
    return new OpenGeniUnixLocalSandboxClient({ snapshot: new NoopSnapshotSpec() });
  },
};
