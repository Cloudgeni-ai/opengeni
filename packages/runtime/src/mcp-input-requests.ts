import { AsyncLocalStorage } from "node:async_hooks";
import {
  McpElicitationApprovalRequest,
  McpElicitationRequestedSchema,
  isMcpElicitationUrlQuestion,
  mcpElicitationUrlHost,
  type McpElicitationContent,
} from "@opengeni/contracts";
import { z } from "zod";

/**
 * MCP elicitation as a durable approval (protocol revision 2026-07-28, multi
 * round-trip pattern). A model's call to a third-party MCP tool declares that
 * it can ask the person to fill in a form or open a web page. When the server
 * answers with `input_required`, the call pauses as an approval of the same
 * call: the questions and the server's opaque `requestState` are kept with the
 * paused call, the person answers or declines in the approval, and the call is
 * retried with that answer. The model only ever sees the call's final result.
 */

/** How many times one tool call may ask before it stops with an error result. */
export const MCP_INPUT_REQUEST_MAX_ROUNDS = 10;
/** `input_required` without questions is retried at once, at most this often in a row. */
const MCP_INPUT_STATE_RETRY_LIMIT = 10;

/** What a model call declares it can answer, in its per-request client capabilities. */
export const MCP_INPUT_CLIENT_CAPABILITIES = {
  elicitation: { form: {}, url: {} },
} as const;

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
 * The person's response to the question a paused call resumes from: an
 * answer, or a decline the server is told about.
 */
export type McpInputAnswer =
  | { request: McpInputRequest; action: "accept"; content: McpElicitationContent }
  | { request: McpInputRequest; action: "decline" };

/**
 * One model tool call's exchange with its server. The approval wrapper creates
 * it; the gateway executor reads the response to send and records a new
 * question.
 */
export type McpInputExchange = {
  server: string;
  /** The question this call is resuming from, with the person's response. */
  answered?: McpInputAnswer;
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

const resumedAnswers = new AsyncLocalStorage<{ callId: string; answer: McpInputAnswer }>();

/** Run a resumed call with the person's response to the question that paused it. */
export function runWithMcpInputAnswer<T>(
  resumed: { callId: string; answer: McpInputAnswer },
  execute: () => T,
): T {
  return resumedAnswers.run(resumed, execute);
}

/** The response a resumed call carries, if this call is the one being resumed. */
export function resumedMcpInputAnswer(callId: string): McpInputAnswer | null {
  const resumed = resumedAnswers.getStore();
  return resumed?.callId === callId ? resumed.answer : null;
}

/** One entry of `inputResponses` for an elicitation request. */
export type McpElicitationInputResponse =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" };

/** What the MCP client sends on one attempt of the call. */
export type McpInputRequiredOption = {
  /** Declared on every attempt: what this call can ask the person. */
  capabilities: typeof MCP_INPUT_CLIENT_CAPABILITIES;
  inputResponses?: Record<string, McpElicitationInputResponse>;
  requestState?: string;
};

/**
 * The first attempt of an exchange: declare, and send the person's response
 * to a resumed question. An accepted form sends its content; an accepted URL
 * question sends none; a decline is sent for every question.
 */
export function mcpInputRequiredOption(exchange: McpInputExchange): McpInputRequiredOption {
  const answered = exchange.answered;
  if (!answered) return { capabilities: MCP_INPUT_CLIENT_CAPABILITIES };
  const inputResponses: Record<string, McpElicitationInputResponse> = {};
  for (const request of answered.request.requests) {
    inputResponses[request.id] =
      answered.action === "decline"
        ? { action: "decline" }
        : isMcpElicitationUrlQuestion(request)
          ? { action: "accept" }
          : { action: "accept", content: answered.content[request.id] ?? {} };
  }
  return {
    capabilities: MCP_INPUT_CLIENT_CAPABILITIES,
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

const Elicitation = z.object({
  method: z.literal("elicitation/create"),
  params: z.union([
    z.object({
      mode: z.literal("url"),
      message: z.string().max(16_384),
      url: z.string().max(8_192),
    }),
    z.object({
      mode: z.literal("form").optional(),
      message: z.string().max(16_384),
      requestedSchema: McpElicitationRequestedSchema,
    }),
  ]),
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
 * What to do with an `input_required` result. Forms and https links pause the
 * call; a state-only result is retried at once; anything this client did not
 * declare (sampling, roots, a malformed form, a link that is not https) ends
 * the call.
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
    return { kind: "retry", option: { capabilities: MCP_INPUT_CLIENT_CAPABILITIES, requestState } };
  }
  const requests: McpInputRequest["requests"] = [];
  for (const [id, entry] of entries) {
    const parsed = Elicitation.safeParse(entry);
    if (!parsed.success) {
      const method =
        entry !== null && typeof entry === "object"
          ? String((entry as { method?: unknown }).method ?? "unknown")
          : "unknown";
      return failed(
        `The MCP server asked for input this client cannot provide (${method === "elicitation/create" ? "a question it does not support" : method}), so the tool call did not finish.`,
      );
    }
    const params = parsed.data.params;
    if ("url" in params) {
      if (mcpElicitationUrlHost(params.url) === null) {
        return failed(
          "The MCP server asked the person to open a link that is not a plain https address, so the tool call did not finish.",
        );
      }
      requests.push({ id, mode: "url", message: params.message, url: params.url });
    } else {
      requests.push({
        id,
        mode: "form",
        message: params.message,
        requestedSchema: params.requestedSchema,
      });
    }
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
