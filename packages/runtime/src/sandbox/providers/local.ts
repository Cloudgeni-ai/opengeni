import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import type { ProviderRegistration } from "./types";

export const localProvider: ProviderRegistration = {
  backend: "local",
  descriptor: CAPABILITY_DESCRIPTORS.local,
  // UnixLocalSandboxClient runs in-process — no credentials, no options.
  validateCredentials() {},
  build() {
    return new UnixLocalSandboxClient();
  },
};
