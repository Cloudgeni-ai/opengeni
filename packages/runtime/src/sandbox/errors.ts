// Typed sandbox-construction errors for the provider registry (module 03 §5.1).
//
// SandboxConfigError is thrown by validateCredentials() and the factory on any
// missing/contradictory provider config — a fail-fast typed error so an
// unknown/misconfigured backend surfaces clearly instead of failing deep inside
// the SDK at create() time.

import type { SandboxBackend } from "@opengeni/contracts";

export class SandboxConfigError extends Error {
  readonly backend: SandboxBackend | string;

  constructor(backend: SandboxBackend | string, message: string) {
    super(`[sandbox:${backend}] ${message}`);
    this.name = "SandboxConfigError";
    this.backend = backend;
  }
}

/** A resume-only caller was handed a warm lease without a provider identity it
 * can resume. The lease-aware caller must retire that exact epoch and re-enter
 * admission; silently creating here would bypass the single-spawner guard. */
export class SandboxResumeStateUnavailableError extends Error {
  readonly backend: SandboxBackend | string;

  constructor(backend: SandboxBackend | string) {
    super(`Sandbox lease for backend "${backend}" has no resumable provider identity`);
    this.name = "SandboxResumeStateUnavailableError";
    this.backend = backend;
  }
}

// Thrown by a provider's build() when its SDK client class is genuinely not
// available in the installed @openai/agents-extensions. Per the P0.3 ruling we
// NEVER fake a build body; if a provider cannot be constructed we register the
// descriptor and make build() throw this. (As of @openai/agents-extensions
// 0.11.6 every provider ships a concrete client, so this is currently unused —
// it is the documented contract for a future drop that loses a provider.)
export class SandboxProviderUnavailableError extends Error {
  readonly backend: SandboxBackend | string;

  constructor(backend: SandboxBackend | string) {
    super(`provider ${backend} not available in installed @openai/agents-extensions`);
    this.name = "SandboxProviderUnavailableError";
    this.backend = backend;
  }
}
