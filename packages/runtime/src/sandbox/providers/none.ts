import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import type { ProviderRegistration } from "./types";

export const noneProvider: ProviderRegistration = {
  backend: "none",
  descriptor: CAPABILITY_DESCRIPTORS.none,
  // No sandbox: nothing to validate, and build() returns undefined. The factory
  // short-circuits on "none" before calling build, but we keep build honest.
  validateCredentials() {},
  build() {
    return undefined;
  },
};
