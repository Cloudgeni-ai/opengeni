import { RunloopSandboxClient } from "@openai/agents-extensions/sandbox/runloop";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const runloopProvider: ProviderRegistration = {
  backend: "runloop",
  descriptor: CAPABILITY_DESCRIPTORS.runloop,
  validateCredentials(settings) {
    if (!settings.runloopApiKey) {
      throw new SandboxConfigError("runloop", "OPENGENI_RUNLOOP_API_KEY is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof RunloopSandboxClient>[0]> = {
      apiKey: settings.runloopApiKey!,
      env: environment,
      exposedPorts,
      // Tunnel v2: one tunnel for all ports. Defaults to true in our config.
      tunnel: settings.runloopTunnel,
    };
    if (settings.runloopBaseUrl) options.baseUrl = settings.runloopBaseUrl;
    if (settings.runloopBlueprintName) options.blueprintName = settings.runloopBlueprintName;
    if (settings.runloopBlueprintId) options.blueprintId = settings.runloopBlueprintId;
    // Runloop's keep-alive lives under the timeouts bag (keepAliveTimeoutMs),
    // NOT a top-level field — the units differ from Modal's idleTimeoutMs.
    if (settings.runloopKeepAliveSeconds) {
      options.timeouts = { keepAliveTimeoutMs: settings.runloopKeepAliveSeconds * 1000 };
    }
    return new RunloopSandboxClient(options);
  },
};
