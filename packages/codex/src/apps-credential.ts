// Typed outcome for the workspace-designated Codex Apps (ChatGPT connectors)
// credential. Apps authorization is separate from inference-account routing, so
// "the designated credential cannot be used" is its own condition, distinct
// from a token refresh failure.

export const CODEX_APPS_CREDENTIAL_UNAVAILABLE_CODE = "codex_apps_credential_unavailable";

/**
 * The workspace's designated Codex Apps credential cannot be used: the
 * designation was cleared or changed, the credential was disconnected or is no
 * longer active, or its owner lost connection-management permission. Never a
 * reason to fall back to another credential.
 */
export class CodexAppsCredentialUnavailable extends Error {
  readonly code: string = CODEX_APPS_CREDENTIAL_UNAVAILABLE_CODE;

  constructor(message = "The designated Codex Apps credential is unavailable") {
    super(message);
    this.name = "CodexAppsCredentialUnavailable";
  }
}

/** Structural check so duplicated package copies still classify the error. */
export function isCodexAppsCredentialUnavailable(error: unknown): boolean {
  return (
    error instanceof CodexAppsCredentialUnavailable ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === CODEX_APPS_CREDENTIAL_UNAVAILABLE_CODE)
  );
}
