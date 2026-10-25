import { ErrorCode as AgentErrorCode } from "@opengeni/agent-proto";
import {
  InteractionControlFailureDetails,
  type ErrorCode,
  type InteractionControlFailureCode,
} from "@opengeni/contracts";
import {
  BrowserControlActionDeadlineError,
  BrowserControlRequestError,
  SelfhostedControlError,
} from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./api-error";

export type InteractionControlSurface = "browser" | "computer";

/** `details.code` of the 504 for an action that outlived its own deadline. */
export const INTERACTION_ACTION_DEADLINE_ERROR_DETAIL_CODE = "INTERACTION_ACTION_DEADLINE_EXCEEDED";

/**
 * A browser or computer action request outlived the deadline derived from its
 * own declared waits. Nothing is unavailable: the controller may still be
 * running the action, so say exactly that instead of the generic "temporarily
 * unavailable — retry" every 5xx becomes, and mark the outcome unknown.
 */
export function interactionActionDeadlineApiError(error: unknown): ApiHttpError | null {
  const deadline =
    error instanceof BrowserControlActionDeadlineError
      ? error
      : error instanceof HTTPException && error.cause instanceof BrowserControlActionDeadlineError
        ? error.cause
        : null;
  if (!deadline) return null;
  const seconds = Math.ceil(deadline.deadlineMs / 1_000);
  const message =
    deadline.surface === "browser"
      ? `The browser action did not finish within its ${seconds}-second limit and may still be running in the browser. Check the page before doing anything again; do not repeat the action automatically.`
      : `The computer action did not finish within its ${seconds}-second limit and may still be running on the computer. Check the window before doing anything again; do not repeat the action automatically.`;
  return new ApiHttpError(504, {
    code: "action_timeout",
    message,
    retryable: false,
    outcomeUnknown: true,
    details: {
      code: INTERACTION_ACTION_DEADLINE_ERROR_DETAIL_CODE,
      deadlineMs: deadline.deadlineMs,
    },
  });
}

/**
 * Agents released before the dedicated `capacity_exhausted` code report a full
 * browser or computer supervisor as a retryable 503 `resource_unavailable`.
 * That is not a transient outage: nothing frees capacity until a session ends.
 * Present it as the current agents do, a 409 that says what to do, instead of
 * the generic "temporarily unavailable" every 5xx becomes.
 */
export function legacyInteractionCapacityFailure(
  error: unknown,
  surface: InteractionControlSurface,
): { code: "capacity_exhausted"; message: string; retryable: false } | null {
  if (
    !(error instanceof BrowserControlRequestError) ||
    error.error.code !== "resource_unavailable" ||
    !error.error.message.endsWith("supervisor session capacity is exhausted")
  ) {
    return null;
  }
  const sessions = surface === "browser" ? "browsers" : "computer sessions";
  const ended = surface === "browser" ? "browser sessions" : "computer sessions";
  return {
    code: "capacity_exhausted",
    message: `This machine is already running its limit of ${sessions}. End ${ended} that are no longer needed, then open a new one; retrying will not help until one ends.`,
    retryable: false,
  };
}

export function legacyInteractionCapacityError(
  error: unknown,
  surface: InteractionControlSurface,
): HTTPException | null {
  const failure = legacyInteractionCapacityFailure(error, surface);
  return failure ? new HTTPException(409, { message: failure.message, cause: error }) : null;
}

/**
 * Projects an internal connected-machine control fault into the public API
 * vocabulary. This is deliberately an allowlist: the agent's free-form message
 * and detail map may contain paths, process output, or provider diagnostics and
 * never cross this boundary. The exact inner request id is safe opaque
 * correlation and links API logs back to the machine operation.
 */
export function interactionControlApiError(
  error: unknown,
  surface: InteractionControlSurface,
): ApiHttpError | null {
  const controlError =
    error instanceof SelfhostedControlError
      ? error
      : error instanceof HTTPException && error.cause instanceof SelfhostedControlError
        ? error.cause
        : null;
  if (!controlError) return null;
  const controlFailureCode = publicControlFailureCode(controlError.code);
  const details = InteractionControlFailureDetails.parse({
    interactionLayer: "connected_machine",
    interactionSurface: surface,
    controlFailureCode,
    ...(safeControlRequestId(controlError.controlRequestId)
      ? { controlRequestId: controlError.controlRequestId }
      : {}),
  });
  const ruling = publicControlFailureRuling(controlError, surface, controlFailureCode);
  return new ApiHttpError(ruling.status, {
    code: ruling.code,
    message: ruling.message,
    retryable: controlError.retryable,
    outcomeUnknown:
      controlError.code === AgentErrorCode.ERROR_CODE_TIMEOUT && !controlError.neverSent,
    details,
  });
}

export function publicControlFailureCode(code: AgentErrorCode): InteractionControlFailureCode {
  switch (code) {
    case AgentErrorCode.ERROR_CODE_UNSUPPORTED:
      return "unsupported";
    case AgentErrorCode.ERROR_CODE_OS:
      return "os";
    case AgentErrorCode.ERROR_CODE_NOT_FOUND:
      return "not_found";
    case AgentErrorCode.ERROR_CODE_CONSENT_REQUIRED:
      return "consent_required";
    case AgentErrorCode.ERROR_CODE_TIMEOUT:
      return "timeout";
    case AgentErrorCode.ERROR_CODE_DRAINING:
      return "draining";
    case AgentErrorCode.ERROR_CODE_PROTOCOL:
      return "protocol";
    case AgentErrorCode.ERROR_CODE_STREAM:
      return "stream";
    case AgentErrorCode.ERROR_CODE_AGENT_OFFLINE:
      return "agent_offline";
    case AgentErrorCode.ERROR_CODE_FENCED:
      return "fenced";
    case AgentErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE:
      return "payload_too_large";
    default:
      return "unknown";
  }
}

function publicControlFailureRuling(
  error: SelfhostedControlError,
  surface: InteractionControlSurface,
  code: InteractionControlFailureCode,
): { status: number; code: ErrorCode; message: string } {
  const liveView = surface === "browser" ? "browser live view" : "computer live view";
  switch (code) {
    case "consent_required":
      return {
        status: 403,
        code: "forbidden",
        message: `Screen access is not enabled for this connected machine's ${liveView}.`,
      };
    case "unsupported":
      return {
        status: 409,
        code: "conflict",
        message: `This connected machine does not support the ${liveView}.`,
      };
    case "not_found":
      return {
        status: 404,
        code: "not_found",
        message: `The connected-machine resource for this ${liveView} no longer exists.`,
      };
    case "fenced":
      return {
        status: 409,
        code: "conflict",
        message: `The connected-machine ${liveView} changed while it was opening.`,
      };
    case "agent_offline":
      return {
        status: 503,
        code: "upstream_unavailable",
        message: `The connected machine is offline, so its ${liveView} is unavailable.`,
      };
    case "draining":
      return {
        status: 503,
        code: "upstream_unavailable",
        message: `The connected machine is busy and could not open the ${liveView}.`,
      };
    case "timeout":
      return {
        status: 504,
        code: "upstream_unavailable",
        message: `The connected machine did not finish opening the ${liveView} in time.`,
      };
    case "payload_too_large":
      return {
        status: 502,
        code: "upstream_unavailable",
        message: `The connected machine could not deliver the ${liveView} within its transport limit.`,
      };
    case "stream":
      return {
        status: error.retryable ? 503 : 502,
        code: "upstream_unavailable",
        message: `The connected machine could not open the ${liveView} stream.`,
      };
    case "protocol":
      return {
        status: 502,
        code: "upstream_unavailable",
        message: `The connected machine returned an invalid ${liveView} response.`,
      };
    case "os":
      return {
        status: 502,
        code: "upstream_unavailable",
        message: `The connected machine could not prepare the ${liveView}.`,
      };
    case "unknown":
      return {
        status: 502,
        code: "upstream_unavailable",
        message: `The connected machine could not open the ${liveView}.`,
      };
  }
}

function safeControlRequestId(value: string | null): value is string {
  return value !== null && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}
