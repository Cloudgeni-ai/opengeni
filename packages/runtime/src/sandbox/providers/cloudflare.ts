import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const cloudflareProvider: ProviderRegistration = {
  backend: "cloudflare",
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
    };
    if (settings.cloudflareApiKey) options.apiKey = settings.cloudflareApiKey;
    return new CloudflareSandboxClient(options);
  },
};
