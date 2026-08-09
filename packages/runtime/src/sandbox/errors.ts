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

/** The OpenGeni-owned envelope identity and the SDK's resumed live handle name
 * different physical providers. Neither address may be guessed away: callers
 * must fail closed before issuing a command or publishing readiness. */
export class SandboxResumeIdentityMismatchError extends Error {
  readonly name = "SandboxResumeIdentityMismatchError";

  constructor(
    public readonly backend: SandboxBackend | string,
    public readonly expectedInstanceId: string,
    public readonly actualInstanceId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Sandbox resume identity mismatch for backend "${backend}": expected ${expectedInstanceId}, resumed ${actualInstanceId}`,
      options,
    );
  }
}

/** Exact resume returned a handle whose physical provider identity cannot be
 * observed. Trusting the requested id here would turn an SDK-created
 * replacement into the original provider by assertion. */
export class SandboxResumeIdentityUnavailableError extends Error {
  readonly name = "SandboxResumeIdentityUnavailableError";

  constructor(
    public readonly backend: SandboxBackend | string,
    public readonly expectedInstanceId: string,
  ) {
    super(
      `Sandbox backend "${backend}" returned an unidentifiable handle while exactly resuming ${expectedInstanceId}`,
    );
  }
}

/** An exact resume request proved that the SDK created/resolved a different
 * provider instance. The replacement has already been torn down before this
 * error is emitted, so the originally-addressed instance can be treated as
 * unavailable without ever publishing or snapshotting the replacement. */
export class SandboxExactResumeReplacedError extends Error {
  readonly name = "SandboxExactResumeReplacedError";
  readonly code = "SANDBOX_NOT_FOUND";

  constructor(
    public readonly backend: SandboxBackend | string,
    public readonly expectedInstanceId: string,
    public readonly replacementInstanceId: string,
  ) {
    super(
      `Sandbox backend "${backend}" could not exactly resume ${expectedInstanceId}; ` +
        `the SDK returned replacement ${replacementInstanceId}, which was discarded`,
    );
  }
}

/** A provider-specific exact-resume preflight proved the addressed execution
 * wrapper absent before an SDK could silently create a replacement. */
export class SandboxExactResumeInstanceUnavailableError extends Error {
  readonly name = "SandboxExactResumeInstanceUnavailableError";
  readonly code = "SANDBOX_NOT_FOUND";

  constructor(
    public readonly backend: SandboxBackend | string,
    public readonly expectedInstanceId: string,
  ) {
    super(`Sandbox backend "${backend}" instance ${expectedInstanceId} is not running`);
  }
}

/** The elected same-workspace recovery could not re-establish its execution
 * wrapper. Callers must retire the continuity receipt before retrying an
 * archive restore (or declaring the workspace unrecoverable). */
export class SandboxProviderContinuityUnavailableError extends Error {
  readonly name = "SandboxProviderContinuityUnavailableError";

  constructor(
    public readonly backend: SandboxBackend | string,
    public readonly sourceInstanceId: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(
      `Sandbox backend "${backend}" could not recover workspace continuity from ${sourceInstanceId}`,
      options,
    );
  }
}

// Thrown by a provider's build() when its SDK client class is genuinely not
// available in the installed @openai/agents-extensions. Per the P0.3 ruling we
// NEVER fake a build body; if a provider cannot be constructed we register the
// descriptor and make build() throw this. (As of @openai/agents-extensions
// 0.14.3 every provider ships a concrete client, so this is currently unused —
// it is the documented contract for a future drop that loses a provider.)
export class SandboxProviderUnavailableError extends Error {
  readonly backend: SandboxBackend | string;

  constructor(backend: SandboxBackend | string) {
    super(`provider ${backend} not available in installed @openai/agents-extensions`);
    this.name = "SandboxProviderUnavailableError";
    this.backend = backend;
  }
}
