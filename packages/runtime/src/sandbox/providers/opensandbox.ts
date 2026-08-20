import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import { OpenSandboxClient } from "./opensandbox-adapter";
import { REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

const IMMUTABLE_OCI_IMAGE = /@sha256:[0-9a-f]{64}$/iu;
/** Desktop-class box: Chromium + XFCE + ttyd will OOM in 1Gi. Two such boxes still fit a D4s_v3. */
export const OPENSANDBOX_DIRECT_RESOURCE_LIMITS = Object.freeze({ cpu: "2", memory: "4Gi" });
export const OPENSANDBOX_DIRECT_RESOURCE_REQUESTS = Object.freeze({
  cpu: "500m",
  memory: "2Gi",
});

function clientOptions(
  settings: Parameters<ProviderRegistration["validateCredentials"]>[0],
  environment: Record<string, string> = {},
  exposedPorts: number[] = [],
) {
  return {
    baseUrl: settings.openSandboxBaseUrl!,
    apiKey: settings.openSandboxApiKey!,
    image: settings.openSandboxImage!,
    ttlSeconds: settings.openSandboxTtlSeconds,
    useServerProxy: settings.openSandboxUseServerProxy,
    readyTimeoutSeconds: Math.ceil(settings.sandboxWarmingTimeoutMs / 1000),
    resourceLimits: OPENSANDBOX_DIRECT_RESOURCE_LIMITS,
    resourceRequests: OPENSANDBOX_DIRECT_RESOURCE_REQUESTS,
    environment,
    exposedPorts,
    ...(settings.openSandboxPoolRef ? { poolRef: settings.openSandboxPoolRef } : {}),
  };
}

export const opensandboxProvider: ProviderRegistration = {
  backend: "opensandbox",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxId"],
  workspaceCapturePolicy: () => REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.opensandbox,
  validateCredentials(settings) {
    if (!settings.openSandboxBaseUrl) {
      throw new SandboxConfigError("opensandbox", "OPENGENI_OPENSANDBOX_BASE_URL is required");
    }
    if (!settings.openSandboxApiKey) {
      throw new SandboxConfigError("opensandbox", "OPENGENI_OPENSANDBOX_API_KEY is required");
    }
    if (!settings.openSandboxImage || !IMMUTABLE_OCI_IMAGE.test(settings.openSandboxImage)) {
      throw new SandboxConfigError(
        "opensandbox",
        "OPENGENI_OPENSANDBOX_IMAGE must be an immutable OCI digest",
      );
    }
  },
  async renewExpiration({ settings, instanceId }) {
    await new OpenSandboxClient(clientOptions(settings)).renewExpiration(instanceId);
  },
  build({ settings, environment, exposedPorts }) {
    return new OpenSandboxClient(clientOptions(settings, environment, exposedPorts));
  },
};
