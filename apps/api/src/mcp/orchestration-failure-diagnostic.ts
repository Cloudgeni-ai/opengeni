import type { ApiRouteDeps } from "@opengeni/core";
import { failureDiagnostic, type FailureDiagnosticInput } from "@opengeni/observability";

type OrchestrationTool = "session_create" | "session_send_message" | "session_steer";
type CallerAttempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

/** Caller identity comes only from the signed grant, never tool arguments. */
export function orchestrationFailureDiagnostic(
  deps: Pick<ApiRouteDeps, "settings" | "observability">,
  tool: OrchestrationTool,
  error: unknown,
  caller: CallerAttempt | null,
) {
  const input: FailureDiagnosticInput = {
    code: "mcp_orchestration_failed",
    stage: `mcp.${tool}`,
    retryDecision: "unknown",
    error,
    ...(caller ?? {}),
  };
  const diagnostic = failureDiagnostic(input, deps.settings.deploymentRevision);
  let diagnosticExport: "disabled" | "queued" | "unavailable" = "disabled";
  if (deps.settings.observabilityDiagnosticsEndpoint) {
    diagnosticExport = "unavailable";
    try {
      const id = deps.observability?.recordFailureDiagnostic({
        ...input,
        diagnosticId: diagnostic.diagnosticId,
      });
      if (id === diagnostic.diagnosticId) diagnosticExport = "queued";
    } catch {
      // Evidence export cannot change the original error or replay the operation.
    }
  }
  // Self-contained safe facts survive the ordinary failed-tool receipt even when
  // the optional protected sink is disabled. Queued is not proof of delivery.
  return { diagnostic, diagnosticExport };
}
