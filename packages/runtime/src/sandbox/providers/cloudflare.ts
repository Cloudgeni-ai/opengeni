import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import { REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

export const cloudflareProvider: ProviderRegistration = {
  backend: "cloudflare",
  exactResumeMode: "ordinary",
  instanceIdFields: ["sandboxId"],
  workspaceCapturePolicy: () => REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.cloudflare,
  validateCredentials(settings) {
    // workerUrl is the addressing root for the Cloudflare Sandbox Worker — there
    // is no construction without it (it is the one non-optional client option).
    if (!settings.cloudflareWorkerUrl) {
      throw new SandboxConfigError("cloudflare", "OPENGENI_CLOUDFLARE_WORKER_URL is required");
    }
  },
  build({ settings, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof CloudflareSandboxClient>[0]> = {
      workerUrl: settings.cloudflareWorkerUrl!,
      exposedPorts,
      // `/persist` is an HTTP request rather than the shared remote-tar helper.
      // Abort its provider transport at the same immutable budget as the
      // durable capture claim; the outer lifecycle fence still owns settlement.
      timeouts: { requestTimeoutMs: settings.sandboxSnapshotTimeoutMs },
    };
    if (settings.cloudflareApiKey) options.apiKey = settings.cloudflareApiKey;
    return new CloudflareSandboxClient(options);
  },
};
