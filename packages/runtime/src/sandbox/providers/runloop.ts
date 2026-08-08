import { RunloopSandboxClient } from "@openai/agents-extensions/sandbox/runloop";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import { REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

export const runloopProvider: ProviderRegistration = {
  backend: "runloop",
  exactResumeMode: "custom",
  instanceIdFields: ["devboxId"],
  // The SDK otherwise creates a non-idempotent native disk snapshot whose
  // provider artifact has no OpenGeni outcome ledger. Lifecycle capture uses
  // the inherited unique-path tar primitive instead.
  workspaceCapturePolicy: () => REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
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
    // Keep the provider-native snapshot request inside the same immutable
    // budget as OpenGeni's durable capture claim. The outer lifecycle timeout
    // remains the final fence; this prevents an abandoned SDK request from
    // needlessly running past it when Runloop supports an exact operation knob.
    // Runloop keep-alive also lives in this bag (ms), not at Modal's top level.
    options.timeouts = {
      snapshotTimeoutMs: settings.sandboxSnapshotTimeoutMs,
      ...(settings.runloopKeepAliveSeconds
        ? { keepAliveTimeoutMs: settings.runloopKeepAliveSeconds * 1000 }
        : {}),
    };
    return new RunloopSandboxClient(options);
  },
};
