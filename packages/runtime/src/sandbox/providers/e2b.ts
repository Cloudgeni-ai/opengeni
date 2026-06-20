import { E2BSandboxClient } from "@openai/agents-extensions/sandbox/e2b";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const e2bProvider: ProviderRegistration = {
  backend: "e2b",
  descriptor: CAPABILITY_DESCRIPTORS.e2b,
  validateCredentials(settings) {
    // The underlying e2b SDK reads E2B_API_KEY from process.env; we mirror it to
    // settings so a misconfigured deployment fails fast here instead of deep in
    // the SDK at create() time.
    if (!settings.e2bApiKey) {
      throw new SandboxConfigError("e2b", "OPENGENI_E2B_API_KEY is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof E2BSandboxClient>[0]> = {
      env: environment,
      exposedPorts,
    };
    if (settings.e2bTemplate) options.template = settings.e2bTemplate;
    // e2b's `timeout` is in SECONDS (the SDK multiplies by 1000 internally) —
    // a different unit from Modal's `timeoutMs`.
    if (settings.e2bTimeoutSeconds) options.timeout = settings.e2bTimeoutSeconds;
    if (settings.e2bTimeoutAction) options.timeoutAction = settings.e2bTimeoutAction;
    if (settings.e2bAllowInternetAccess !== undefined) {
      options.allowInternetAccess = settings.e2bAllowInternetAccess;
    }
    if (settings.e2bAutoResume !== undefined) options.autoResume = settings.e2bAutoResume;
    if (settings.e2bWorkspacePersistence) {
      options.workspacePersistence = settings.e2bWorkspacePersistence;
    }
    return new E2BSandboxClient(options);
  },
};
