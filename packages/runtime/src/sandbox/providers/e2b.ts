import { E2BSandboxClient } from "@openai/agents-extensions/sandbox/e2b";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import {
  REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
  providerWorkspacePersistence,
  type ProviderRegistration,
} from "./types";

export const e2bProvider: ProviderRegistration = {
  backend: "e2b",
  exactResumeMode: "custom",
  instanceIdFields: ["sandboxId"],
  workspaceCapturePolicy: (state) =>
    providerWorkspacePersistence(state) === "snapshot"
      ? REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE
      : REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.e2b,
  validateCredentials(settings) {
    // build() hands the key to the SDK; checking it here makes a misconfigured
    // deployment fail fast instead of deep in the SDK at create() time.
    if (!settings.e2bApiKey) {
      throw new SandboxConfigError("e2b", "OPENGENI_E2B_API_KEY is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof E2BSandboxClient>[0]> = {
      env: environment,
      exposedPorts,
    };
    // Where and as whom the SDK connects, for every create and resume. The
    // client keeps it out of serialized session state.
    const connection: NonNullable<typeof options.connection> = {};
    if (settings.e2bApiKey) connection.apiKey = settings.e2bApiKey;
    if (settings.e2bDomain) connection.domain = settings.e2bDomain;
    if (settings.e2bApiUrl) connection.apiUrl = settings.e2bApiUrl;
    if (settings.e2bSandboxUrl) connection.sandboxUrl = settings.e2bSandboxUrl;
    options.connection = connection;
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
