import { ErrorCode as AgentErrorCode } from "@opengeni/agent-proto";
import {
  InteractionControlFailureDetails,
  type ErrorCode,
  type InteractionControlFailureCode,
} from "@opengeni/contracts";
import { SelfhostedControlError } from "@opengeni/runtime/sandbox";
import { ApiHttpError } from "./api-error";

export type InteractionControlSurface = "browser" | "computer";

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
  if (!(error instanceof SelfhostedControlError)) return null;
  const controlFailureCode = publicControlFailureCode(error.code);
  const details = InteractionControlFailureDetails.parse({
    interactionLayer: "connected_machine",
    interactionSurface: surface,
    controlFailureCode,
    ...(safeControlRequestId(error.controlRequestId)
      ? { controlRequestId: error.controlRequestId }
      : {}),
  });
  const ruling = publicControlFailureRuling(error, surface, controlFailureCode);
  return new ApiHttpError(ruling.status, {
    code: ruling.code,
    message: ruling.message,
    retryable: error.retryable,
    outcomeUnknown: error.code === AgentErrorCode.ERROR_CODE_TIMEOUT && !error.neverSent,
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
