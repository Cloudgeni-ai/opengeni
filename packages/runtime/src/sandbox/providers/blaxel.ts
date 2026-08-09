import { BlaxelSandboxClient } from "@openai/agents-extensions/sandbox/blaxel";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import { REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

export const blaxelProvider: ProviderRegistration = {
  backend: "blaxel",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxIdentity"],
  workspaceCapturePolicy: () => REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.blaxel,
  validateCredentials(settings) {
    if (!settings.blaxelApiKey) {
      throw new SandboxConfigError("blaxel", "OPENGENI_BLAXEL_API_KEY is required");
    }
  },
  build({ settings, environment }) {
    // Blaxel exposes ports ON DEMAND (the only such backend) — its options take
    // no `exposedPorts: number[]` list; 6080 is resolved at handshake time, so
    // we do NOT pre-declare it here (this is why the factory's 6080-merge is
    // gated on !supportsOnDemandPorts).
    const options: NonNullable<ConstructorParameters<typeof BlaxelSandboxClient>[0]> = {
      apiKey: settings.blaxelApiKey!,
      env: environment,
      // persistWorkspace() creates a remote tarball. Bound that provider-native
      // operation by the same immutable deadline as the durable capture claim;
      // OpenGeni's outer timeout still protects every provider uniformly.
      timeouts: { workspaceTarTimeoutMs: settings.sandboxSnapshotTimeoutMs },
    };
    if (settings.blaxelImage) options.image = settings.blaxelImage;
    if (settings.blaxelRegion) options.region = settings.blaxelRegion;
    if (settings.blaxelExposedPortPublic !== undefined) {
      options.exposedPortPublic = settings.blaxelExposedPortPublic;
    }
    if (settings.blaxelExposedPortUrlTtlSeconds) {
      options.exposedPortUrlTtlS = settings.blaxelExposedPortUrlTtlSeconds;
    }
    if (settings.blaxelMemoryMb) options.memory = settings.blaxelMemoryMb;
    if (settings.blaxelTtl) options.ttl = settings.blaxelTtl;
    return new BlaxelSandboxClient(options);
  },
};
