// Opengeni compute: managed microVMs from Opengeni's own sandbox fabric, each
// running the Connected Machine agent. See docs/compute-backend.md.

import {
  computeAgentApiUrl,
  computeSettingsIssues,
  resolveEnrollmentSigningSecret,
} from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { ComputeFabricClient } from "../compute/fabric";
import { getComputeAgentPlane } from "../compute/plane";
import { ComputeSandboxClient } from "../compute/session";
import { SandboxConfigError } from "../errors";
import { resolveRelayConfig } from "./selfhosted";
import { REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

export const computeProvider: ProviderRegistration = {
  backend: "compute",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxId"],
  // The fabric persists the box itself. A portable tar is only the read-only
  // capture that moves a workspace to another backend.
  workspaceCapturePolicy: () => REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.compute,
  validateCredentials(settings) {
    const issues = computeSettingsIssues(settings);
    if (issues.length > 0) throw new SandboxConfigError("compute", issues.join("; "));
  },
  build({ settings, environment }) {
    return new ComputeSandboxClient({
      fabric: new ComputeFabricClient({
        baseUrl: settings.computeApiUrl!,
        apiKey: settings.computeApiKey!,
      }),
      plane: getComputeAgentPlane,
      relay: resolveRelayConfig(settings),
      image:
        (settings.sandboxDesktopEnabled ? settings.computeDesktopImage : settings.computeImage) ??
        settings.computeImage ??
        null,
      vcpus: settings.computeVcpus,
      memoryMib: settings.computeMemoryMib,
      ...(settings.computeMemoryRequestMib !== undefined
        ? { memoryRequestMib: settings.computeMemoryRequestMib }
        : {}),
      ...(settings.computeCpuRequestMillis !== undefined
        ? { cpuRequestMillis: settings.computeCpuRequestMillis }
        : {}),
      agentApiUrl: computeAgentApiUrl(settings)!,
      enrollmentSigningSecret: resolveEnrollmentSigningSecret(settings)!,
      readyTimeoutMs: settings.computeAgentReadyTimeoutMs,
      controlTimeoutMs: settings.sandboxSelfhostedControlTimeoutMs,
      execTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
      environment,
    });
  },
};
