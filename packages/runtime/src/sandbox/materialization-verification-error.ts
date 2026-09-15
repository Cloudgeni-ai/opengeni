export type MaterializationFailureReason =
  | "path_not_visible"
  | "command_failed"
  | "command_pending"
  | "invalid_response"
  | "command_error";

/** Exact diagnostics belong only in authenticated durable session events.
 * Metrics receive the closed reason vocabulary, never paths or provider output. */
export type MaterializationVerificationDiagnostic = {
  reason: MaterializationFailureReason;
  path: string;
  workdir: string;
  command: string;
  output: string | null;
  exitCode: number | null;
  providerSessionId: number | null;
  /** Exact ephemeral read-only probe identity, never a retained command alias. */
  providerExecution?: { sandboxId: string; taskId: string; execId: string };
  causeMessage?: string;
};

const EXPLANATIONS: Record<MaterializationFailureReason, string> = {
  path_not_visible: "the provider could not see the destination path",
  command_failed: "the visibility-check command exited unsuccessfully",
  command_pending: "the visibility-check command was still running; path visibility is unconfirmed",
  invalid_response: "the visibility check returned no valid success confirmation",
  command_error: "the provider could not complete the visibility-check command",
};

export class SandboxMaterializationVerificationError extends Error {
  readonly code = "sandbox_materialization_verification_failed";

  constructor(
    readonly diagnostic: MaterializationVerificationDiagnostic,
    options?: ErrorOptions,
  ) {
    super(
      `Sandbox materialization verification failed: ${EXPLANATIONS[diagnostic.reason]}: ${diagnostic.path}`,
      options,
    );
    this.name = "SandboxMaterializationVerificationError";
  }
}

const providerDiagnostics = new WeakMap<object, MaterializationVerificationDiagnostic>();

/** Keep cancellation, route-loss, and provider retry identities unchanged. */
export function retainMaterializationVerificationDiagnostic(
  error: unknown,
  diagnostic: MaterializationVerificationDiagnostic,
): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    providerDiagnostics.set(error, diagnostic);
  }
}

export function materializationVerificationDiagnostic(
  error: unknown,
): MaterializationVerificationDiagnostic | undefined {
  if (error instanceof SandboxMaterializationVerificationError) return error.diagnostic;
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? providerDiagnostics.get(error)
    : undefined;
}
