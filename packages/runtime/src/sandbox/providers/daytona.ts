import { DaytonaSandboxClient } from "@openai/agents-extensions/sandbox/daytona";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const daytonaProvider: ProviderRegistration = {
  backend: "daytona",
  descriptor: CAPABILITY_DESCRIPTORS.daytona,
  validateCredentials(settings) {
    if (!settings.daytonaApiKey) {
      throw new SandboxConfigError("daytona", "OPENGENI_DAYTONA_API_KEY is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof DaytonaSandboxClient>[0]> = {
      apiKey: settings.daytonaApiKey!,
      env: environment,
      exposedPorts,
    };
    if (settings.daytonaApiUrl) options.apiUrl = settings.daytonaApiUrl;
    if (settings.daytonaTarget) options.target = settings.daytonaTarget;
    if (settings.daytonaImage) options.image = settings.daytonaImage;
    if (settings.daytonaSnapshotName) options.sandboxSnapshotName = settings.daytonaSnapshotName;
    // autoStopInterval=0 disables the idle-kill, so forward 0 explicitly.
    if (settings.daytonaAutoStopInterval !== undefined) {
      options.autoStopInterval = settings.daytonaAutoStopInterval;
    }
    if (settings.daytonaTimeoutSeconds) options.timeoutSec = settings.daytonaTimeoutSeconds;
    if (settings.daytonaExposedPortUrlTtlSeconds) {
      options.exposedPortUrlTtlS = settings.daytonaExposedPortUrlTtlSeconds;
    }
    return new DaytonaSandboxClient(options);
  },
};
