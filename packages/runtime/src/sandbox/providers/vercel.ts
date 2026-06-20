import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const vercelProvider: ProviderRegistration = {
  backend: "vercel",
  descriptor: CAPABILITY_DESCRIPTORS.vercel,
  validateCredentials(settings) {
    // Vercel needs the access token + the project/team it scopes to.
    if (!settings.vercelToken) {
      throw new SandboxConfigError("vercel", "OPENGENI_VERCEL_TOKEN is required");
    }
    if (!settings.vercelProjectId) {
      throw new SandboxConfigError("vercel", "OPENGENI_VERCEL_PROJECT_ID is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof VercelSandboxClient>[0]> = {
      token: settings.vercelToken!,
      projectId: settings.vercelProjectId!,
      env: environment,
      exposedPorts,
    };
    if (settings.vercelTeamId) options.teamId = settings.vercelTeamId;
    if (settings.vercelRuntime) options.runtime = settings.vercelRuntime;
    return new VercelSandboxClient(options);
  },
};
