// Opengeni compute: managed microVMs run by Opengeni itself, each
// running the Connected Machine agent. See docs/compute-backend.md.

import { computeSettingsIssues } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { ComputeControlClient } from "../compute/control";
import { getComputeAgentPlane } from "../compute/plane";
import { ComputeSandboxClient } from "../compute/session";
import { SandboxConfigError } from "../errors";
import { resolveRelayConfig } from "./selfhosted";
import { ROTATION_ONLY_PORTABLE_TAR_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

/** A request window that outlasts a wake from disk (the host holds a message
 * for up to 120 s) plus the agent's reply. */
export const COMPUTE_MIN_REQUEST_TIMEOUT_MS = 130_000;

export const computeProvider: ProviderRegistration = {
  backend: "compute",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxId"],
  // Compute persists the sandbox itself. A portable tar is only the read-only
  // capture that rotates, archives or moves a workspace; no warm checkpoints.
  workspaceCapturePolicy: () => ROTATION_ONLY_PORTABLE_TAR_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.compute,
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
      image: (desktop ? settings.computeDesktopImage : undefined) ?? settings.computeImage ?? null,
      desktop,
      vcpus: settings.computeVcpus,
      memoryMib: settings.computeMemoryMib,
      ...(settings.computeMemoryRequestMib !== undefined
        ? { memoryRequestMib: settings.computeMemoryRequestMib }
        : {}),
      ...(settings.computeCpuRequestMillis !== undefined
        ? { cpuRequestMillis: settings.computeCpuRequestMillis }
        : {}),
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
