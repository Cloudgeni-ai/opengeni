import { DockerSandboxClient } from "@openai/agents/sandbox/local";
import { isAbsolute } from "node:path";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const dockerProvider: ProviderRegistration = {
  backend: "docker",
  descriptor: CAPABILITY_DESCRIPTORS.docker,
  // Local dev container — no credentials. (The dockerNetwork decoration is
  // applied by the factory, not here: it wraps the constructed client.)
  validateCredentials(settings) {
    const workspaceBaseDir = settings.dockerWorkspaceBaseDir?.trim();
    if (workspaceBaseDir && !isAbsolute(workspaceBaseDir)) {
      throw new SandboxConfigError(
        "docker",
        "OPENGENI_DOCKER_WORKSPACE_BASE_DIR must be an absolute path",
      );
    }
  },
  build({ settings, exposedPorts }) {
    const workspaceBaseDir = settings.dockerWorkspaceBaseDir?.trim();
    return new DockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts,
      ...(workspaceBaseDir ? { workspaceBaseDir } : {}),
    });
  },
};
