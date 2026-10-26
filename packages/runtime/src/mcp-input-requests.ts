import { AsyncLocalStorage } from "node:async_hooks";
import {
  McpElicitationApprovalRequest,
  McpElicitationRequestedSchema,
  type McpElicitationContent,
} from "@opengeni/contracts";
import { z } from "zod";

/**
 * MCP form elicitation as a durable approval (protocol revision 2026-07-28,
 * multi round-trip pattern). A model's call to a third-party MCP tool declares
 * that it can answer form questions. When the server answers with
 * `input_required`, the call pauses as an approval of the same call: the
 * questions and the server's opaque `requestState` are kept with the paused
 * call, the person answers them in the approval, and the call is retried with
 * those answers. The model only ever sees the call's final result.
 */

/** How many times one tool call may ask before it stops with an error result. */
export const MCP_INPUT_REQUEST_MAX_ROUNDS = 10;
/** `input_required` without questions is retried at once, at most this often in a row. */
const MCP_INPUT_STATE_RETRY_LIMIT = 10;

/**
 * The agents SDK pauses a call whose invocation returns an object carrying
 * this symbol, and keeps the value on the approval item under the same symbol.
 */
export const TOOL_CALL_AWAITS_APPROVAL = Symbol.for("opengeni.toolCall.awaitsApproval");

/** Private state of a paused call: stored with the call, never in events. */
export const McpInputRequest = z.object({
  /** Display name of the server that asked. */
  server: z.string().min(1).max(256),
  /** 1 for the call's first question, then one more for each later one. */
  round: z.number().int().min(1).max(MCP_INPUT_REQUEST_MAX_ROUNDS),
  requests: McpElicitationApprovalRequest.shape.requests,
  /** The server's opaque state, echoed byte for byte on the retry. */
  requestState: z.string().optional(),
});
export type McpInputRequest = z.infer<typeof McpInputRequest>;

/**
 * One model tool call's exchange with its server. The approval wrapper creates
 * it; the gateway executor reads the answer to send and records a new question.
 */
export type McpInputExchange = {
  server: string;
  /** The question this call is resuming from, with the person's answers. */
  answered?: { request: McpInputRequest; content: McpElicitationContent };
  /** Set when the server asked (again); the call then pauses. */
  requested?: McpInputRequest;
};

/** The public `elicitation` projection of a paused call's request. */
export function mcpElicitationApproval(request: McpInputRequest): McpElicitationApprovalRequest {
  return { server: request.server, requests: request.requests };
}

/** The tool output that pauses the call until the person answers. */
export function awaitingMcpInput(request: McpInputRequest): {
  [TOOL_CALL_AWAITS_APPROVAL]: McpInputRequest;
} {
  return { [TOOL_CALL_AWAITS_APPROVAL]: request };
}

/**
 * The request carried by a pausing tool output or an SDK approval item, or
 * null. Only requests this runtime created carry the symbol.
 */
export function mcpInputRequestOf(value: unknown): McpInputRequest | null {
  if (value === null || typeof value !== "object") return null;
  const request = (value as { [TOOL_CALL_AWAITS_APPROVAL]?: unknown })[TOOL_CALL_AWAITS_APPROVAL];
  const parsed = McpInputRequest.safeParse(request);
  return parsed.success ? parsed.data : null;
}

/** Parse a paused call's stored request. */
export function parseMcpInputRequest(value: unknown): McpInputRequest {
  return McpInputRequest.parse(value);
}

const resumedAnswers = new AsyncLocalStorage<{
  callId: string;
  request: McpInputRequest;
  content: McpElicitationContent;
}>();

/** Run a resumed call with the person's answers to the question that paused it. */
export function runWithMcpInputAnswer<T>(
  answer: { callId: string; request: McpInputRequest; content: McpElicitationContent },
  execute: () => T,
): T {
  return resumedAnswers.run(answer, execute);
}

/** The answers a resumed call carries, if this call is the one being resumed. */
export function resumedMcpInputAnswer(
  callId: string,
): { request: McpInputRequest; content: McpElicitationContent } | null {
  const answer = resumedAnswers.getStore();
  return answer?.callId === callId ? { request: answer.request, content: answer.content } : null;
}

/** What the MCP client sends on one attempt of the call. */
export type McpInputRequiredOption = {
  inputResponses?: Record<string, { action: "accept"; content: Record<string, unknown> }>;
  requestState?: string;
};

/** The first attempt of an exchange: declare, and answer a resumed question. */
export function mcpInputRequiredOption(exchange: McpInputExchange): McpInputRequiredOption {
  const answered = exchange.answered;
  if (!answered) return {};
  const inputResponses: NonNullable<McpInputRequiredOption["inputResponses"]> = {};
  for (const request of answered.request.requests) {
    inputResponses[request.id] = {
      action: "accept",
      content: answered.content[request.id] ?? {},
    };
  }
  return {
    inputResponses,
    ...(answered.request.requestState !== undefined
      ? { requestState: answered.request.requestState }
      : {}),
  };
}

type InputRequiredResult = {
  resultType: "input_required";
  inputRequests?: unknown;
  requestState?: unknown;
};

export function isMcpInputRequiredResult(value: unknown): value is InputRequiredResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { resultType?: unknown }).resultType === "input_required"
  );
}

const FormElicitation = z.object({
  method: z.literal("elicitation/create"),
  params: z.object({
    mode: z.literal("form").optional(),
    message: z.string().max(16_384),
    requestedSchema: McpElicitationRequestedSchema,
  }),
});

export type McpInputRequiredStep =
  /** Retry at once with only this state. */
  | { kind: "retry"; option: McpInputRequiredOption }
  /** The call pauses for the person; the exchange records the request. */
  | { kind: "ask"; request: McpInputRequest }
  /** The call ends with this error result. */
  | { kind: "fail"; result: { isError: true; content: [{ type: "text"; text: string }] } };

function failed(text: string): Extract<McpInputRequiredStep, { kind: "fail" }> {
  return { kind: "fail", result: { isError: true, content: [{ type: "text", text }] } };
}

/**
 * What to do with an `input_required` result. Form questions pause the call;
 * a state-only result is retried at once; anything this client did not
 * declare (URL mode, sampling, roots, a malformed form) ends the call.
 */
export function nextMcpInputRequiredStep(
  exchange: McpInputExchange,
  result: InputRequiredResult,
  stateRetries: number,
): McpInputRequiredStep {
  const requestState = typeof result.requestState === "string" ? result.requestState : undefined;
  const entries =
    result.inputRequests !== null && typeof result.inputRequests === "object"
      ? Object.entries(result.inputRequests as Record<string, unknown>)
      : [];
  if (entries.length === 0) {
    if (requestState === undefined || stateRetries >= MCP_INPUT_STATE_RETRY_LIMIT) {
      return failed(
        "The MCP server kept answering that it needs more input without saying what, so the tool call did not finish.",
      );
    }
    return { kind: "retry", option: { requestState } };
  }
  const requests: McpInputRequest["requests"] = [];
  for (const [id, entry] of entries) {
    const parsed = FormElicitation.safeParse(entry);
    if (!parsed.success) {
      const method =
        entry !== null && typeof entry === "object"
          ? String((entry as { method?: unknown }).method ?? "unknown")
          : "unknown";
      return failed(
        `The MCP server asked for input this client cannot provide (${method === "elicitation/create" ? "a form it does not support" : method}), so the tool call did not finish.`,
      );
    }
    requests.push({
      id,
      message: parsed.data.params.message,
      requestedSchema: parsed.data.params.requestedSchema,
    });
  }
  const round = (exchange.answered?.request.round ?? 0) + 1;
  if (round > MCP_INPUT_REQUEST_MAX_ROUNDS) {
    return failed(
      `The MCP server asked the person more than ${MCP_INPUT_REQUEST_MAX_ROUNDS} times during this tool call, so the call was stopped.`,
    );
  }
  const request = McpInputRequest.safeParse({
    server: exchange.server,
    round,
    requests,
    ...(requestState !== undefined ? { requestState } : {}),
  });
  if (!request.success) {
    return failed(
      "The MCP server asked for input this client cannot provide (too many questions), so the tool call did not finish.",
    );
  }
  return { kind: "ask", request: request.data };
}

/** Stand-in result while the call waits; the approval wrapper replaces it. */
export const MCP_INPUT_PENDING_RESULT = {
  isError: true as const,
  content: [
    {
      type: "text" as const,
      text: "The MCP server asked the person a question; this call is waiting for their answer.",
    },
  ],
};
