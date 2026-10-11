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
    reason: actionReceiptReason(receipt),
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
    reason: actionReceiptReason(receipt),
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
    reason: actionReceiptReason(response.operation),
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

function actionReceiptReason(receipt: Pick<InteractionActionReceipt, "state" | "error">): string {
  if (receipt.state !== "failed") return "none";
  const code = receipt.error?.code;
  return code && INTERACTION_ERROR_REASONS.has(code) ? code : "action_failed";
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, performance.now() - startedAtMs);
}

type InteractionRouteOperation = {
  resource: "browser" | "computer";
  operation: string;
  mode: string;
  /** The handler already records its successful outcome from the receipt. */
  successObservedByHandler: boolean;
};

const BROWSER = "/v1/workspaces/:workspaceId/browser-sessions";
const COMPUTER = "/v1/workspaces/:workspaceId/computer-sessions";
const B = `${BROWSER}/:browserSessionId`;
const C = `${COMPUTER}/:computerSessionId`;

/**
 * Every Browser/Computer control route the product depends on, keyed by
 * `METHOD route-label`. Read-only listing/detail routes are deliberately
 * absent: they are not user-visible operations and stay in the generic HTTP
 * metrics.
 */
const INTERACTION_ROUTE_OPERATIONS = new Map<string, InteractionRouteOperation>(
  (
    [
      ["POST", BROWSER, "browser", "create", "lifecycle", true],
      ["GET", `${B}/targets`, "browser", "observe", "semantic", false],
      ["POST", `${B}/targets`, "browser", "open_target", "lifecycle", false],
      ["POST", `${B}/targets/:targetId/select`, "browser", "select_target", "lifecycle", false],
      ["DELETE", `${B}/targets/:targetId`, "browser", "close_target", "lifecycle", false],
      ["GET", `${B}/targets/:targetId/observation`, "browser", "observe", "semantic", false],
      ["GET", `${B}/targets/:targetId/state`, "browser", "observe", "semantic", false],
      ["POST", `${B}/targets/:targetId/dom-read`, "browser", "observe", "semantic", false],
      ["GET", `${B}/targets/:targetId/screenshot`, "browser", "observe", "media", false],
      ["POST", `${B}/actions`, "browser", "act", "semantic", true],
      ["POST", `${B}/auth-runs`, "browser", "auth_start", "auth", true],
      ["POST", `${B}/auth-runs/:authRunId/report`, "browser", "auth_report", "auth", true],
      ["POST", `${B}/auth-runs/:authRunId/protected-fill`, "browser", "auth_fill", "auth", true],
      ["POST", `${B}/auth-runs/:authRunId/external-auth`, "browser", "auth_start", "auth", true],
      [
        "POST",
        `${B}/auth-runs/:authRunId/external-auth/interactive`,
        "browser",
        "auth_start",
        "auth",
        true,
      ],
      ["POST", `${B}/auth-runs/:authRunId/verify`, "browser", "auth_verify", "auth", true],
      ["POST", `${B}/attachments`, "browser", "attach", "human", false],
      ["POST", `${B}/revisions`, "browser", "publish", "lifecycle", true],
      ["POST", `${B}/suspend`, "browser", "suspend", "lifecycle", true],
      ["POST", `${B}/resume`, "browser", "resume", "lifecycle", true],
      ["POST", `${B}/end`, "browser", "end", "lifecycle", true],
      ["POST", COMPUTER, "computer", "create", "lifecycle", true],
      ["GET", `${C}/targets`, "computer", "observe", "semantic", false],
      ["GET", `${C}/targets/:targetId/observation`, "computer", "observe", "semantic", false],
      ["GET", `${C}/targets/:targetId/screenshot`, "computer", "observe", "media", false],
      ["POST", `${C}/actions`, "computer", "act", "semantic", true],
      ["POST", `${C}/attachments`, "computer", "attach", "human", false],
      ["POST", `${C}/end`, "computer", "end", "lifecycle", true],
    ] as const
  ).map(([method, route, resource, operation, mode, successObservedByHandler]) => [
    `${method} ${route}`,
    { resource, operation, mode, successObservedByHandler },
  ]),
);

export function interactionRouteOperation(
  method: string,
  route: string,
): InteractionRouteOperation | null {
  return INTERACTION_ROUTE_OPERATIONS.get(`${method} ${route}`) ?? null;
}

const INTERACTION_ERROR_REASONS = new Set([
  "resource_not_found",
  "resource_unavailable",
  "controller_stale",
  "target_not_found",
  "target_stale",
  "observation_stale",
  "document_stale",
  "frame_stale",
  "locator_not_found",
  "locator_ambiguous",
  "unsupported",
  "permission_denied",
  "machine_locked",
  "attempt_stale",
  "operation_conflict",
  "outcome_unknown",
  "invalid_action",
  "timeout",
  "controller_lost",
  "driver_failed",
]);

/**
 * Bounded failure reason for a refused or failed interaction route, derived
 * only from the HTTP status and the content-free rejection classification.
 */
export function interactionRouteFailureReason(
  status: number,
  rejectionReason: string | undefined,
): string {
  if (rejectionReason?.startsWith("permission:")) return "permission_denied";
  if (rejectionReason?.startsWith("control:")) return rejectionReason.replace(":", "_");
  if (rejectionReason && INTERACTION_ERROR_REASONS.has(rejectionReason)) return rejectionReason;
  if (rejectionReason && STALE_INTERACTION_ERROR_CODES.has(rejectionReason)) return "stale";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  if (status === 502 || status === 503) return "unavailable";
  return status >= 500 ? "internal" : "rejected";
}

/**
 * Observe the HTTP-level outcome of an interaction route. Routes whose handler
 * already records success from its receipt are counted here only on failure,
 * so every attempt is counted exactly once.
 */
export function observeInteractionRouteOutcome(
  observability: Observability | null | undefined,
  input: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
    rejectionReason?: string | undefined;
  },
): void {
  const operation = interactionRouteOperation(input.method, input.route);
  if (!operation) return;
  const failed = input.status >= 400;
  if (!failed && operation.successObservedByHandler) return;
  const reason = failed
    ? interactionRouteFailureReason(input.status, input.rejectionReason)
    : "none";
  interactionOperationMetricObserver(observability)({
    resource: operation.resource,
    operation: operation.operation,
    mode: operation.mode,
    outcome: !failed
      ? "completed"
      : reason === "stale" || STALE_INTERACTION_ERROR_CODES.has(reason)
        ? "stale"
        : input.status === 401 || input.status === 403
          ? "denied"
          : "failed",
    reason,
    durationMs: input.durationMs,
  });
}
