import {
  DockerSandboxClient,
  DockerSandboxSession,
  type DockerSandboxClientOptions,
} from "@openai/agents/sandbox/local";
import { NoopSnapshotSpec } from "@openai/agents/sandbox";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError, SandboxExactResumeInstanceUnavailableError } from "../errors";
import { REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

const execFileAsync = promisify(execFile);
const DOCKER_EXACT_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

type DockerResumeState = {
  containerId?: unknown;
  workspaceRootPath?: unknown;
  workspaceRootOwned?: unknown;
  snapshot?: unknown;
};

function dockerContinuityKey(state: unknown): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = state as DockerResumeState;
  // OpenGeni explicitly disables the SDK's local snapshot facility. Requiring
  // that invariant prevents the SDK from restoring an older local snapshot
  // over a newer host workspace before restarting the container.
  return typeof value.workspaceRootPath === "string" &&
    isAbsolute(value.workspaceRootPath) &&
    value.workspaceRootOwned === true &&
    (value.snapshot === null || value.snapshot === undefined)
    ? value.workspaceRootPath
    : null;
}

function preserveDockerWorkspaceForDiscard(session: unknown, sessionState: unknown): void {
  for (const candidate of [(session as { state?: unknown } | null)?.state, sessionState]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    (candidate as { workspaceRootOwned?: boolean }).workspaceRootOwned = false;
  }
}

function dockerInspectMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const stderr = Reflect.get(error, "stderr");
  return typeof stderr === "string" ? stderr.trim() : "";
}

function dockerInspectProvesMissing(error: unknown, containerId: string): boolean {
  const escaped = containerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Error: No such (?:object|container): ${escaped}$`).test(
    dockerInspectMessage(error),
  );
}

class OpenGeniDockerSandboxClient extends DockerSandboxClient {
  readonly #openGeniOptions: DockerSandboxClientOptions;

  constructor(options: DockerSandboxClientOptions = {}) {
    super(options);
    this.#openGeniOptions = options;
  }

  /** Exact attach must not call the SDK's ordinary resume when the persisted
   * container is absent: ordinary resume intentionally starts a new container.
   * The elected recovery owner calls ordinary resume through the shared
   * continuity protocol instead. */
  async resumeExact(
    state: Parameters<DockerSandboxClient["resume"]>[0],
    options?: Parameters<DockerSandboxClient["resume"]>[1],
  ) {
    const containerId = (state as DockerResumeState).containerId;
    if (typeof containerId !== "string" || !DOCKER_INSTANCE_ID.test(containerId)) {
      throw new SandboxConfigError("docker", "persisted Docker container identity is invalid");
    }
    try {
      const result = await execFileAsync(
        "docker",
        ["inspect", "--type", "container", "--format", "{{.State.Running}}", containerId],
        { timeout: DOCKER_EXACT_INSPECT_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      );
      if (result.stdout.trim() !== "true") {
        throw new SandboxExactResumeInstanceUnavailableError("docker", containerId);
      }
    } catch (error) {
      if (
        error instanceof SandboxExactResumeInstanceUnavailableError ||
        dockerInspectProvesMissing(error, containerId)
      ) {
        throw new SandboxExactResumeInstanceUnavailableError("docker", containerId);
      }
      throw error;
    }
    // Do not call super.resume() after the preflight. The container can vanish
    // between those operations and the SDK then restores/restarts a replacement.
    // A direct session wrapper is non-mutating; a later command may fail if the
    // container stopped after inspect, which is the correct fenced outcome.
    const archiveLimits =
      options?.archiveLimits === undefined
        ? this.#openGeniOptions.archiveLimits
        : options.archiveLimits;
    return new DockerSandboxSession({
      state,
      ...(archiveLimits !== undefined ? { archiveLimits } : {}),
    });
  }
}

export const dockerProvider: ProviderRegistration = {
  backend: "docker",
  exactResumeMode: "custom",
  instanceIdFields: ["containerId"],
  workspaceCapturePolicy: () => REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  continuity: {
    kind: "docker_workspace",
    keyFromState: dockerContinuityKey,
    preserveWorkspaceForDiscard: preserveDockerWorkspaceForDiscard,
  },
  descriptor: CAPABILITY_DESCRIPTORS.docker,
  // Local dev container — no credentials. (The dockerNetwork decoration is
  // applied by the factory, not here: it wraps the constructed client.)
  validateCredentials(settings) {
    const workspaceBaseDir = settings.dockerWorkspaceBaseDir?.trim();
    if (workspaceBaseDir && !isAbsolute(workspaceBaseDir)) {
      throw new SandboxConfigError(
        "docker",
        "OPENGENI_DOCKER_WORKSPACE_BASE_DIR must be an absolute path",
      );
    }
  },
  build({ settings, exposedPorts }) {
    const workspaceBaseDir = settings.dockerWorkspaceBaseDir?.trim();
    return new OpenGeniDockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts,
      // The OpenGeni archive ledger is the recovery authority. SDK-local
      // snapshots are process-host artifacts and, more importantly, ordinary
      // Docker resume may overwrite a newer live host workspace from them.
      snapshot: new NoopSnapshotSpec(),
      ...(workspaceBaseDir ? { workspaceBaseDir } : {}),
    });
  },
};
