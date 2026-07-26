import { DockerSandboxClient } from "@openai/agents/sandbox/local";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import type { ProviderRegistration } from "./types";

export const dockerProvider: ProviderRegistration = {
  backend: "docker",
  descriptor: CAPABILITY_DESCRIPTORS.docker,
  // Local dev container — no credentials. (The dockerNetwork decoration is
  // applied by the factory, not here: it wraps the constructed client.)
  validateCredentials() {},
  build({ settings, exposedPorts }) {
    return new DockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts,
    });
  },
};
