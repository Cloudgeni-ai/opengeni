// Opengeni compute: managed microVMs from Opengeni's own sandbox fabric, each
// running the Connected Machine agent. See docs/compute-backend.md.

import { computeSettingsIssues } from "@opengeni/config";
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
  // The fabric persists the sandbox itself. A portable tar is only the read-only
  // capture that moves a workspace to another backend.
  workspaceCapturePolicy: () => REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
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
      fabric: new ComputeFabricClient({
        baseUrl: settings.computeApiUrl!,
        apiKey: settings.computeApiKey!,
      }),
      plane: getComputeAgentPlane,
      relay: resolveRelayConfig(settings),
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
      controlTimeoutMs: settings.sandboxSelfhostedControlTimeoutMs,
      execTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
      environment,
    });
  },
};
