import type {
  AuthRunMutationResponse,
  BrowserActionReceipt,
  BrowserActionRequest,
  PublishBrowserRevisionResponse,
  BrowserSessionMutationResponse,
  ComputerActionReceipt,
  ComputerActionRequest,
  ComputerSessionMutationResponse,
  InteractionInterventionMutationResponse,
  ProtectedAuthFillResponse,
} from "@opengeni/contracts";
import {
  interactionAuthMetricObserver,
  interactionInterventionMetricObserver,
  interactionOperationMetricObserver,
  type Observability,
} from "@opengeni/observability";
import type { ComputerFrameEvidenceMismatchReason } from "@opengeni/runtime/sandbox";

type InteractionActionReceipt = BrowserActionReceipt | ComputerActionReceipt;
type InteractionLifecycleMutation =
  | BrowserSessionMutationResponse
  | ComputerSessionMutationResponse;
type AuthMutation = AuthRunMutationResponse | ProtectedAuthFillResponse;

const STALE_INTERACTION_ERROR_CODES = new Set([
  "controller_stale",
  "target_stale",
  "observation_stale",
  "document_stale",
  "frame_stale",
  "attempt_stale",
]);

const COMPUTER_FRAME_EVIDENCE_MISMATCH_REASONS = new Set<ComputerFrameEvidenceMismatchReason>([
  "frame_session_mismatch",
  "frame_target_mismatch",
  "frame_controller_mismatch",
  "frame_media_mismatch",
  "frame_digest_mismatch",
]);

export function observeBrowserActionResult(
  observability: Observability | null | undefined,
  startedAtMs: number,
  request: BrowserActionRequest,
  receipt: BrowserActionReceipt,
): void {
  interactionOperationMetricObserver(observability)({
    resource: "browser",
    operation: "act",
    mode: browserActionMode(request.action),
    outcome: actionReceiptOutcome(receipt),
    durationMs: elapsedMs(startedAtMs),
  });
}

export function observeComputerActionResult(
  observability: Observability | null | undefined,
  startedAtMs: number,
  request: ComputerActionRequest,
  receipt: ComputerActionReceipt,
): void {
  interactionOperationMetricObserver(observability)({
    resource: "computer",
    operation: "act",
    mode: computerActionMode(request.action.type),
    outcome: actionReceiptOutcome(receipt),
    durationMs: elapsedMs(startedAtMs),
  });
}

export function observeComputerFrameEvidenceMismatch(
  observability: Observability | null | undefined,
  reason: ComputerFrameEvidenceMismatchReason,
): void {
  if (!observability || !COMPUTER_FRAME_EVIDENCE_MISMATCH_REASONS.has(reason)) return;
  try {
    observability.incrementCounter({
      name: "opengeni_computer_frame_evidence_mismatches_total",
      help: "Computer frame evidence rejected at the controller-to-API boundary by bounded reason.",
      labels: { reason },
    });
  } catch {
    // Observability cannot alter the fail-closed frame boundary.
  }
  try {
    observability.warn("Computer frame evidence mismatch", { reason });
  } catch {
    // Observability cannot alter the fail-closed frame boundary.
  }
}

export function observeLifecycleResult(
  observability: Observability | null | undefined,
  startedAtMs: number,
  response: InteractionLifecycleMutation,
): void {
  interactionOperationMetricObserver(observability)({
    resource: response.operation.resourceKind === "browser_session" ? "browser" : "computer",
    operation: response.operation.kind,
    mode: "lifecycle",
    outcome: actionReceiptOutcome(response.operation),
    durationMs: elapsedMs(startedAtMs),
    replayed: response.operation.replayed,
  });
}

export function observeBrowserRevisionPublication(
  observability: Observability | null | undefined,
  startedAtMs: number,
  response: PublishBrowserRevisionResponse,
): void {
  interactionOperationMetricObserver(observability)({
    resource: "browser",
    operation: "publish",
    mode: "lifecycle",
    outcome: "completed",
    durationMs: elapsedMs(startedAtMs),
    replayed: response.replayed,
  });
}

export function observeAuthMutation(
  observability: Observability | null | undefined,
  startedAtMs: number,
  response: AuthMutation,
): void {
  interactionAuthMetricObserver(observability)({
    state: response.run.state,
    durationMs: elapsedMs(startedAtMs),
    replayed: response.replayed,
  });
}

export function observeInterventionMutation(
  observability: Observability | null | undefined,
  response: InteractionInterventionMutationResponse,
): void {
  const { intervention } = response;
  interactionInterventionMetricObserver(observability)({
    kind: intervention.kind,
    outcome: intervention.status === "open" ? "opened" : intervention.status,
    ...(intervention.settledAt
      ? {
          waitMs: Math.max(
            0,
            Date.parse(intervention.settledAt) - Date.parse(intervention.createdAt),
          ),
        }
      : {}),
    replayed: response.replayed,
  });
}

function browserActionMode(action: BrowserActionRequest["action"]): string {
  const actions = action.type === "batch" ? action.actions : [action];
  if (actions.some((candidate) => candidate.type === "pointer")) return "coordinate";
  if (actions.some((candidate) => candidate.type === "type" || candidate.type === "press")) {
    return "keyboard";
  }
  if (actions.some((candidate) => candidate.type === "clipboard")) return "clipboard";
  if (actions.some((candidate) => candidate.type === "permission")) return "permission";
  return "semantic";
}

function computerActionMode(type: ComputerActionRequest["action"]["type"]): string {
  if (type === "pointer") return "coordinate";
  if (type === "keyboard") return "keyboard";
  if (type === "clipboard") return "clipboard";
  if (type === "launch") return "lifecycle";
  return "semantic";
}

function actionReceiptOutcome(receipt: Pick<InteractionActionReceipt, "state" | "error">): string {
  if (
    receipt.state === "failed" &&
    receipt.error &&
    STALE_INTERACTION_ERROR_CODES.has(receipt.error.code)
  ) {
    return "stale";
  }
  return receipt.state;
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, performance.now() - startedAtMs);
}
