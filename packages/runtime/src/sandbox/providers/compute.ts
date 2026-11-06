// Opengeni compute: managed microVMs run by Opengeni itself, each
// running the Connected Machine agent. See docs/compute-backend.md.

import { computeSettingsIssues, type Settings } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { ComputeControlClient, ComputeControlError } from "../compute/control";
import { getComputeAgentPlane } from "../compute/plane";
import { ComputeSandboxClient } from "../compute/session";
import { SandboxConfigError } from "../errors";
import { resolveRelayConfig } from "./selfhosted";
import {
  ROTATION_ONLY_PORTABLE_TAR_WORKSPACE_CAPTURE,
  type ProviderImmutableImageBuildResult,
  type ProviderRegistration,
} from "./types";

/** A request window that outlasts a wake from disk (the host holds a message
 * for up to 120 s) plus the agent's reply. */
export const COMPUTE_MIN_REQUEST_TIMEOUT_MS = 130_000;

/** The image new compute sandboxes boot, as `build` chooses it: the desktop
 * image on a desktop deployment when one is configured, else the image. Null
 * means the control service's default image, which can change under the same
 * settings. */
export function computeSourceImage(settings: Settings): string | null {
  const desktop = settings.sandboxDesktopEnabled === true;
  return (desktop ? settings.computeDesktopImage : undefined) ?? settings.computeImage ?? null;
}

/** The team template name a Sandbox Environment build captures under. The
 * build request id is deterministic for one target and content, so a retried
 * build finds the template an earlier attempt captured instead of storing
 * another. */
export function computeEnvironmentTemplateName(requestId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(requestId)) {
    throw new Error("compute template builds need a UUID build request id");
  }
  return `opengeni-environment-${requestId}`;
}

function computeControlFor(
  settings: Settings,
  options: { requestTimeoutMs?: number; maxAttempts?: number } = {},
): ComputeControlClient {
  if (!settings.computeApiUrl || !settings.computeApiKey) {
    throw new SandboxConfigError("compute", "the compute control service is not configured");
  }
  return new ComputeControlClient({
    baseUrl: settings.computeApiUrl,
    apiKey: settings.computeApiKey,
    ...options,
  });
}

export type ComputeProviderBinding = { provider: "compute"; apiUrl: string; team: string };

const computeBindings = new Map<
  string,
  Promise<{ key: string; binding: ComputeProviderBinding }>
>();

/** The compute team behind the configured key, at its control service: the
 * namespace templates live in. A prebuilt environment is used only while the
 * deployment still reaches that exact team. Cached per process and key; a
 * failed lookup is not cached. */
export async function resolveComputeProviderBinding(
  settings: Settings,
  control: Pick<ComputeControlClient, "linkKeys"> = computeControlFor(settings, {
    requestTimeoutMs: 10_000,
    maxAttempts: 2,
  }),
): Promise<{ key: string; binding: ComputeProviderBinding }> {
  const apiUrl = (settings.computeApiUrl ?? "").replace(/\/+$/u, "");
  const cacheKey = `${apiUrl}\0${settings.computeApiKey ?? ""}`;
  const cached = computeBindings.get(cacheKey);
  if (cached) return await cached;
  const pending = control.linkKeys().then(({ team }) => {
    if (typeof team !== "string" || !team) {
      throw new Error("the compute control service named no team for this key");
    }
    const binding: ComputeProviderBinding = { provider: "compute", apiUrl, team };
    return { key: `compute:${apiUrl}:${team}`, binding };
  });
  computeBindings.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    if (computeBindings.get(cacheKey) === pending) computeBindings.delete(cacheKey);
    throw error;
  }
}

/** Delete one team template a build made. Gone is success. */
export async function deleteComputeTemplate(settings: Settings, template: string): Promise<void> {
  await computeControlFor(settings, { maxAttempts: 2 }).deleteTemplate(template);
}

/** Capture a verified sandbox's disk as a team template. A template of the
 * build's name that already exists is that same build's earlier capture. */
export async function buildComputeEnvironmentTemplate(
  input: { settings: Settings; session: unknown; requestId: string; timeoutMs: number },
  control: Pick<
    ComputeControlClient,
    "captureTemplate" | "getTemplate" | "linkKeys"
  > = computeControlFor(input.settings, {
    requestTimeoutMs: Math.max(input.timeoutMs, COMPUTE_MIN_REQUEST_TIMEOUT_MS),
    maxAttempts: 2,
  }),
): Promise<ProviderImmutableImageBuildResult> {
  const state = (input.session as { state?: { sandboxId?: unknown } } | null)?.state;
  const sandboxId = typeof state?.sandboxId === "string" ? state.sandboxId : null;
  if (!sandboxId) {
    throw new Error("compute template builds need the exact live sandbox identity");
  }
  const name = computeEnvironmentTemplateName(input.requestId);
  const binding = await resolveComputeProviderBinding(input.settings, control);
  let template;
  try {
    template = await control.captureTemplate(sandboxId, name, {
      timeoutMs: Math.max(input.timeoutMs, COMPUTE_MIN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (!(error instanceof ComputeControlError && error.kind === "exists")) throw error;
    template = await control.getTemplate(name);
    if (!template) throw error;
  }
  if (!template?.id) throw new Error("the compute template capture returned no template id");
  return {
    provider: "compute",
    backend: "compute",
    imageId: template.id,
    imageDigest: template.image || null,
    providerBindingKey: binding.key,
    providerBinding: binding.binding,
  };
}

export const computeProvider: ProviderRegistration = {
  backend: "compute",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxId"],
  // Compute persists the sandbox itself. A portable tar is only the read-only
  // capture that rotates, archives or moves a workspace; no warm checkpoints.
  workspaceCapturePolicy: () => ROTATION_ONLY_PORTABLE_TAR_WORKSPACE_CAPTURE,
  // A verified Sandbox Environment is captured as a team template (ADR 22),
  // so fresh sandboxes boot with its setup already done.
  buildImmutableImage: (input) => buildComputeEnvironmentTemplate(input),
  descriptor: CAPABILITY_DESCRIPTORS.compute,
  // Commands run over the Connected Machine operation stream; long ones become
  // background commands, not stdin sessions. The relay PTY in the descriptor is
  // the person's terminal.
  sessionSupportsPty: false,
  validateCredentials(settings) {
    const issues = computeSettingsIssues(settings);
    if (issues.length > 0) throw new SandboxConfigError("compute", issues.join("; "));
  },
  build({ settings, environment }) {
    // The desktop tier starts the agent with its own virtual desktop, from the
    // desktop image when one is configured.
    const desktop = settings.sandboxDesktopEnabled === true;
    return new ComputeSandboxClient({
      control: new ComputeControlClient({
        baseUrl: settings.computeApiUrl!,
        apiKey: settings.computeApiKey!,
      }),
      plane: getComputeAgentPlane,
      relay: resolveRelayConfig(settings),
      gateway: settings.computeLinkUrl!,
      image: computeSourceImage(settings),
      ...(settings.computeTemplate ? { template: settings.computeTemplate } : {}),
      desktop,
      vcpus: settings.computeVcpus,
      memoryMib: settings.computeMemoryMib,
      ...(settings.computeMemoryRequestMib !== undefined
        ? { memoryRequestMib: settings.computeMemoryRequestMib }
        : {}),
      ...(settings.computeCpuRequestMillis !== undefined
        ? { cpuRequestMillis: settings.computeCpuRequestMillis }
        : {}),
      ...(settings.computeDiskMib !== undefined ? { diskMib: settings.computeDiskMib } : {}),
      readyTimeoutMs: settings.computeAgentReadyTimeoutMs,
      // The first request after idle takes the sandbox's wake: its host holds
      // the message for up to 120 s while the sandbox wakes and its agent
      // reconnects, so every compute request window covers that.
      controlTimeoutMs: Math.max(
        settings.sandboxSelfhostedControlTimeoutMs,
        COMPUTE_MIN_REQUEST_TIMEOUT_MS,
      ),
      execTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
      environment,
    });
  },
};
