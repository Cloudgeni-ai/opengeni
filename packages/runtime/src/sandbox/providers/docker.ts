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
import {
  createDockerTrustedRigPlatformSurface,
  inspectDockerTrustedRigPlatformRuntime,
} from "./docker-trusted-rig-platform-surface";
import {
  REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  type ProviderImmutableImageBuildInput,
  type ProviderImmutableImageBuildResult,
  type ProviderRegistration,
} from "./types";

const execFileAsync = promisify(execFile);
const DOCKER_EXACT_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DOCKER_CONTAINER_ID = /^[0-9a-f]{12,64}$/u;
const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_BUILD_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOCKER_RIG_PROVIDER_IMAGE_LABEL = "io.opengeni.rig-provider-image";
const DOCKER_RIG_PROVIDER_REQUEST_LABEL = "io.opengeni.rig-provider-build-request";
const DOCKER_RIG_PROVIDER_IMAGE_VERSION = "1";

type DockerResumeState = {
  containerId?: unknown;
  image?: unknown;
  workspaceRootPath?: unknown;
  workspaceRootOwned?: unknown;
  snapshot?: unknown;
};

/** A cold continuity owner is the only caller allowed to replace a missing
 * Docker execution wrapper while preserving its host workspace. The durable
 * provider state carries the image of the missing container; prefer the
 * currently configured image for the replacement so a deployment upgrade
 * cannot publish a new lease image while silently restarting the old one. */
export function dockerContinuityResumeStateForImage<T>(
  state: T,
  configuredImage: string | undefined,
): T {
  const image = configuredImage?.trim();
  if (!image || !state || typeof state !== "object" || Array.isArray(state)) return state;
  return { ...state, image };
}

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

export function dockerInspectProvesMissing(error: unknown, containerId: string): boolean {
  const escaped = containerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:Error|Error response from daemon): No such (?:object|container): ${escaped}$`,
  ).test(dockerInspectMessage(error));
}

function dockerImageInspectProvesMissing(error: unknown, image: string): boolean {
  const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:Error|Error response from daemon): No such image: ${escaped}$`).test(
    dockerInspectMessage(error),
  );
}

type DockerImmutableImageCommand = (
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const runDockerImmutableImageCommand: DockerImmutableImageCommand = async (args, timeoutMs) =>
  await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 256 * 1024 });

function dockerRigProviderImageTag(requestId: string): string {
  if (!DOCKER_BUILD_REQUEST_ID.test(requestId)) {
    throw new Error("Docker provider image build requires a valid UUID request id");
  }
  return `opengeni-rig-provider:${requestId.toLowerCase()}`;
}

async function inspectDockerRigProviderImage(input: {
  tag: string;
  requestId: string;
  timeoutMs: number;
  command: DockerImmutableImageCommand;
}): Promise<string | null> {
  let result: Awaited<ReturnType<DockerImmutableImageCommand>>;
  try {
    result = await input.command(
      [
        "image",
        "inspect",
        "--format",
        `{{.Id}}\n{{index .Config.Labels "${DOCKER_RIG_PROVIDER_IMAGE_LABEL}"}}\n{{index .Config.Labels "${DOCKER_RIG_PROVIDER_REQUEST_LABEL}"}}`,
        input.tag,
      ],
      input.timeoutMs,
    );
  } catch (error) {
    if (dockerImageInspectProvesMissing(error, input.tag)) return null;
    throw error;
  }
  const [imageId, version, requestId] = result.stdout.trim().split(/\r?\n/u);
  if (
    !imageId ||
    !DOCKER_IMAGE_ID.test(imageId) ||
    version !== DOCKER_RIG_PROVIDER_IMAGE_VERSION ||
    requestId !== input.requestId
  ) {
    throw new Error("Docker provider image tag is owned by another build protocol");
  }
  return imageId;
}

/** Commit the exact verified Docker container under a deterministic request
 * tag. A retry first resolves that tag, so an acknowledgement lost after the
 * daemon committed the image reuses the same immutable object instead of
 * starting a different logical build. */
export async function buildDockerImmutableImage(
  input: ProviderImmutableImageBuildInput,
  command: DockerImmutableImageCommand = runDockerImmutableImageCommand,
): Promise<ProviderImmutableImageBuildResult> {
  const session = input.session as { state?: { containerId?: unknown } };
  const containerId = session.state?.containerId;
  if (typeof containerId !== "string" || !DOCKER_CONTAINER_ID.test(containerId)) {
    throw new Error("Docker provider image build requires an exact live container identity");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("Docker provider image build requires a finite timeout");
  }
  const deadlineAtMs = Date.now() + input.timeoutMs;
  const remainingMs = (): number => {
    const remaining = Math.floor(deadlineAtMs - Date.now());
    if (remaining <= 0) throw new Error("Docker provider image build deadline was reached");
    return Math.max(1, remaining);
  };
  const tag = dockerRigProviderImageTag(input.requestId);
  const existing = await inspectDockerRigProviderImage({
    tag,
    requestId: input.requestId,
    timeoutMs: remainingMs(),
    command,
  });
  if (existing) {
    return {
      provider: "docker",
      backend: "docker",
      imageId: existing,
      imageDigest: null,
      providerBindingKey: null,
      providerBinding: null,
    };
  }

  const inspected = await command(
    ["inspect", "--type", "container", "--format", "{{.Id}}\n{{.State.Running}}", containerId],
    remainingMs(),
  );
  const [resolvedContainerId, running] = inspected.stdout.trim().split(/\r?\n/u);
  if (
    !resolvedContainerId ||
    !/^[0-9a-f]{64}$/u.test(resolvedContainerId) ||
    !resolvedContainerId.startsWith(containerId) ||
    running !== "true"
  ) {
    throw new Error("Docker provider image build requires the exact container to be running");
  }

  const committed = await command(
    [
      "commit",
      "--pause=true",
      "--change",
      `LABEL ${DOCKER_RIG_PROVIDER_IMAGE_LABEL}=${DOCKER_RIG_PROVIDER_IMAGE_VERSION}`,
      "--change",
      `LABEL ${DOCKER_RIG_PROVIDER_REQUEST_LABEL}=${input.requestId}`,
      resolvedContainerId,
      tag,
    ],
    remainingMs(),
  );
  const committedImageId = committed.stdout.trim();
  if (!DOCKER_IMAGE_ID.test(committedImageId)) {
    throw new Error("Docker provider image commit returned no immutable image id");
  }
  const imageId = await inspectDockerRigProviderImage({
    tag,
    requestId: input.requestId,
    timeoutMs: remainingMs(),
    command,
  });
  if (imageId !== committedImageId) {
    throw new Error("Docker provider image tag changed before publication");
  }
  return {
    provider: "docker",
    backend: "docker",
    imageId,
    imageDigest: null,
    providerBindingKey: null,
    providerBinding: null,
  };
}

class OpenGeniDockerSandboxClient extends DockerSandboxClient {
  readonly #openGeniOptions: DockerSandboxClientOptions;
  readonly #providerImmutableImage: boolean;

  constructor(options: DockerSandboxClientOptions = {}, providerImmutableImage = false) {
    super(options);
    this.#openGeniOptions = options;
    this.#providerImmutableImage = providerImmutableImage;
  }

  override async create(
    args?: Parameters<DockerSandboxClient["create"]>[0],
    manifestOptions?: Parameters<DockerSandboxClient["create"]>[1],
  ) {
    const image = this.#openGeniOptions.image;
    if (this.#providerImmutableImage && image) {
      try {
        await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
          timeout: DOCKER_EXACT_INSPECT_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
        });
      } catch (error) {
        if (dockerImageInspectProvesMissing(error, image)) {
          throw Object.assign(
            new Error(`Docker immutable provider image ${image} is unavailable`),
            { code: "RESOURCE_NOT_FOUND" },
          );
        }
        throw error;
      }
    }
    return await super.create(args, manifestOptions);
  }

  /** Ordinary resume is reserved by OpenGeni for the elected cold continuity
   * owner. Exact live attachment uses resumeExact() below and never reimages. */
  override async resume(
    state: Parameters<DockerSandboxClient["resume"]>[0],
    options?: Parameters<DockerSandboxClient["resume"]>[1],
  ) {
    return await super.resume(
      dockerContinuityResumeStateForImage(state, this.#openGeniOptions.image),
      options,
    );
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
  buildImmutableImage: buildDockerImmutableImage,
  createTrustedRigPlatformSurface: createDockerTrustedRigPlatformSurface,
  inspectTrustedRigPlatformRuntime: inspectDockerTrustedRigPlatformRuntime,
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
    return new OpenGeniDockerSandboxClient(
      {
        image: settings.dockerImageId ?? settings.dockerImage,
        exposedPorts,
        // The OpenGeni archive ledger is the recovery authority. SDK-local
        // snapshots are process-host artifacts and, more importantly, ordinary
        // Docker resume may overwrite a newer live host workspace from them.
        snapshot: new NoopSnapshotSpec(),
        ...(workspaceBaseDir ? { workspaceBaseDir } : {}),
      },
      settings.dockerImageId !== undefined,
    );
  },
};
