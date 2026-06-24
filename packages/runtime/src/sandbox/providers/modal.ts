import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { effectiveModalIdleTimeoutSeconds } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const modalProvider: ProviderRegistration = {
  backend: "modal",
  descriptor: CAPABILITY_DESCRIPTORS.modal,
  validateCredentials(settings) {
    // both-or-neither (preserves existing validation at config validateSettings).
    if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
      throw new SandboxConfigError(
        "modal",
        "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
      );
    }
    if (!settings.modalAppName) {
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_APP_NAME is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof ModalSandboxClient>[0]> = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      exposedPorts,
      env: environment,
    };
    // gap-fill (module 03 §4.1): these SDK options were previously unmapped.
    // ALWAYS pin idleTimeoutMs (sandbox-file-persistence): an UNSET idle timeout
    // lets the SDK send idleTimeoutSecs=undefined, so Modal applies its short
    // server-default idle-reap and kills an idle (between-turns) box LONG before
    // OpenGeni's reaper can resume+snapshot it. effectiveModalIdleTimeoutSeconds
    // defaults this to the hard lifetime so the box survives its full warm window
    // and the reaper — not Modal's idle-reap — governs teardown (and snapshots
    // /workspace first).
    options.idleTimeoutMs = effectiveModalIdleTimeoutSeconds(settings) * 1000;
    if (settings.modalWorkspacePersistence) {
      options.workspacePersistence = settings.modalWorkspacePersistence;
    }
    if (settings.modalImageRef) {
      options.image = ModalImageSelector.fromTag(settings.modalImageRef);
    }
    if (settings.modalTokenId) {
      options.tokenId = settings.modalTokenId;
    }
    if (settings.modalTokenSecret) {
      options.tokenSecret = settings.modalTokenSecret;
    }
    if (settings.modalEnvironment) {
      options.environment = settings.modalEnvironment;
    }
    return new ModalSandboxClient(options);
  },
};
