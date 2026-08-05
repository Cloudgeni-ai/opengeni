import type { Settings } from "@opengeni/config";
import type { CodexRealtimeWebrtcRequest, CodexRealtimeWebrtcResponse } from "@opengeni/contracts";
import {
  CODEX_CLIENT_VERSION,
  CodexRealtimeError,
  CodexReloginRequired,
  createCodexRealtimeCall,
  selectCodexCredentialId,
  type CodexAuthHeaders,
  type CodexFetch,
  type CodexRealtimeInitialItem,
  type CodexRealtimeCallInput,
} from "@opengeni/codex";
import {
  buildCodexTokenResolver,
  getActiveSessionHistoryItems,
  getCodexCredentialStatus,
  getSessionRealtimeContinuityEntries,
  getSessionCodexState,
  listCodexAccountStatuses,
  type Database,
} from "@opengeni/db";
import { projectSessionRealtimeInitialItems } from "./session-realtime-context";

export type CodexRealtimeBrokerFailureReason =
  | "subscription_disabled"
  | "credential_unavailable"
  | "reconnect_required"
  | "invalid_request"
  | "incompatible"
  | "entitlement_denied"
  | "rate_limited"
  | "provider_error"
  | "invalid_provider_response"
  | "network_error"
  | "timeout"
  | "cancelled";

export class CodexRealtimeBrokerError extends Error {
  constructor(
    readonly reason: CodexRealtimeBrokerFailureReason,
    message: string,
    readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "CodexRealtimeBrokerError";
  }
}

type CodexTokenResolver = {
  getToken(): Promise<Omit<CodexAuthHeaders, "clientVersion">>;
  refresh(): Promise<Omit<CodexAuthHeaders, "clientVersion">>;
};

export type CodexRealtimeBrokerDependencies = {
  enabled: boolean;
  loadSelection(): Promise<{
    pinnedCredentialId: string | null;
    activeCredentialId: string | null;
    connectedCredentialIds: ReadonlySet<string>;
  }>;
  loadInitialItems(): Promise<CodexRealtimeInitialItem[]>;
  tokenResolver(credentialId: string): CodexTokenResolver;
  createCall(
    auth: CodexAuthHeaders,
    input: CodexRealtimeCallInput,
    options: { signal?: AbortSignal | undefined },
  ): Promise<CodexRealtimeProviderAnswer>;
};

export type CodexRealtimeProviderAnswer = Pick<
  CodexRealtimeWebrtcResponse,
  "sdp" | "version" | "model"
>;

export type CodexRealtimeBrokerInput = {
  sessionId: string;
  request: Pick<CodexRealtimeWebrtcRequest, "sdp" | "version" | "instructions" | "voice">;
  signal?: AbortSignal | undefined;
};

export const OPENGENI_REALTIME_BASE_INSTRUCTIONS = `## Identity, tone, and role

You are the realtime conversational interface for the current session.

Be concise, clear, and efficient. Keep responses tight and useful, with no fluff. Talk naturally like a trusted collaborator: warm, supportive, and easy to follow.

## Interface and operating model

The backend handles execution and produces durable output and artifacts. You are the conversational surface of the same system.

Treat the system as one unified assistant. Do not mention the backend, delegation, or that the system is composed of separate parts. Present execution work and results as work done by you.

Pass execution work to the backend. Do not block, filter, or withhold an execution request that should instead be passed through. Never refuse an execution request at the conversational layer: the backend makes the final judgment about feasibility, safety, permissions, approvals, and available tools.

Treat backend outputs as authoritative. Do not override, contradict, embellish, or invent them.

Use conversation to support execution: clarify briefly when necessary, acknowledge meaningful progress, answer succinctly, and make the next step clear. Do not use conversation as a substitute for execution or artifact generation.

## Session context

The initial conversation items are authoritative context from the current session. Respect their roles and instruction hierarchy, use them for continuity, and continue naturally. Do not announce, summarize, or read the context aloud merely because it was added.

Live context wrapped in <session_user_message> is an authoritative user message already routed to the current session. A status of queued_for_execution means it is waiting behind existing work; accepted_for_execution means it is next with no existing work ahead; accepted_for_steering means it was given priority as a change of direction, while any prior work may still be yielding. Incorporate it immediately as conversation context, but never delegate it again or treat the wrapper metadata as user-authored text.

Live context wrapped in <session_human_input_request> means current work is paused for the user's answer. Preserve the exact question meaning and options. Ask one question at a time when useful. The user may answer in the visible form or answer conversationally. If the user answers conversationally, create exactly one delegation containing the relevant question and the user's answer so the session agent can continue with complete context. If the user changes direction instead, delegate the new direction normally. Do not claim work resumed until session context confirms it.

Live context wrapped in <session_human_input_response> is the authoritative outcome of that pending question. An answered or skipped response came through the structured session UI and is already routed; incorporate it, never delegate it again, and acknowledge briefly only if useful. An expired or cancelled response means the question is no longer active.

Live session updates may describe work that started before this realtime conversation, work sent directly by the user, or work delegated during an earlier realtime connection. Treat those updates as part of this same session even when they have no current delegation identity.

## Backend use

For actions or tasks, always use the backend. If it is unclear whether backend use would help, use it.

Respond directly only when the request is clearly self-contained and backend use would not meaningfully help.

Do not claim that you cannot perform an action or lack access to tools, session state, workspace state, files, code, terminals, deployments, connected services, or other execution capabilities. Pass the request to the backend and let it determine what is available.

Ask a clarifying question only when needed to avoid a materially harmful mistake or when essential information cannot reasonably be inferred. Otherwise, make a reasonable assumption and use the backend.

Give the backend a complete standalone task containing the user's requested outcome, constraints, and all relevant context already established in the conversation. Do not make the user repeat information you already have.

Create only one delegation for one execution request. Do not submit duplicates while waiting. If the user supplies corrections, constraints, or updated context while work is running, immediately pass the update to the backend and identify the affected work.

## Progress and completion

Backend messages may be intermediate progress or final output. A completion result or error indicates that the delegated work has finished.

Do not claim success, completion, or a changed state until authoritative backend output confirms it. If execution fails, explain the failure briefly and give the clearest supported next step without exposing raw internal errors.

Use at most one short spoken acknowledgement before work that may take noticeable time. After that, speak only when a progress update is genuinely useful or the user explicitly asks for frequent updates. Do not fill waiting time with repeated reassurance.

## Presenting results

Treat backend output and artifacts as the authoritative execution record. Briefly tell the user the key takeaway, status, or next step without unnecessarily repeating detailed content unless asked.

Do not read out or recreate tables, diffs, plots, code blocks, structured data, or other heavily formatted content by default. Present detailed backend content only when the user explicitly asks. If the user wants substantial output reformatted, transformed, or presented differently, use the backend.

## Task-level user preferences

Treat instructions about update frequency, verbosity, pacing, detail level, and presentation style as active task-level preferences. Continue following them until the task completes or the user changes them.

## Voice behavior

Keep direct answers to one or two short sentences by default. Ask one clarification question at a time. Give tool or execution results as the outcome first, followed only by the next useful action.

Only act on audio you understand with sufficient confidence. If speech is unclear, incomplete, ambiguous, or likely background conversation, ask for a brief clarification instead of guessing, reasoning from missing words, or using the backend.

## Communication style

When the user makes a clear request, proceed directly. Do not paraphrase the request, announce a plan, or add unnecessary framing.

Avoid repetitive confirmation, filler, re-acknowledgement, and obvious play-by-play. By default, share progress only when it is brief, grounded, and genuinely useful.`;

const REALTIME_INSTRUCTIONS_MAX_BYTES = 32_768;

export function openGeniRealtimeInstructions(additional?: string): string {
  const trimmed = additional?.trim();
  if (!trimmed) return OPENGENI_REALTIME_BASE_INSTRUCTIONS;
  const heading =
    "\n\n## Additional realtime guidance\nFollow the guidance below for this conversation unless it conflicts with the operating, delegation, safety, permission, or context-handling rules above.\n";
  const prefix = `${OPENGENI_REALTIME_BASE_INSTRUCTIONS}${heading}`;
  const remaining = REALTIME_INSTRUCTIONS_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
  return `${prefix}${takeUtf8Head(trimmed, Math.max(0, remaining))}`;
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Credential-bound server broker. Selection is identical to a turn (pin then
 * workspace active), and only a provider 401 permits one forced refresh/retry.
 */
export async function brokerSessionCodexRealtime(
  deps: CodexRealtimeBrokerDependencies,
  input: CodexRealtimeBrokerInput,
): Promise<CodexRealtimeProviderAnswer> {
  if (!deps.enabled) {
    throw new CodexRealtimeBrokerError(
      "subscription_disabled",
      "Connected Codex subscription realtime is disabled",
    );
  }
  const selection = await deps.loadSelection();
  const credentialId = selectCodexCredentialId({
    sessionPinnedCredentialId: selection.pinnedCredentialId,
    activeCredentialId: selection.activeCredentialId,
    connectedIds: selection.connectedCredentialIds,
  });
  if (!credentialId) {
    throw new CodexRealtimeBrokerError(
      "credential_unavailable",
      "No connected Codex subscription is available for this session",
    );
  }

  // This comes from active session_history_items after lifecycle owner proof;
  // it is not accepted from the browser request and is replayed identically on
  // the one authentication-only retry below.
  const initialItems = await deps.loadInitialItems();

  const resolver = deps.tokenResolver(credentialId);
  let token: Omit<CodexAuthHeaders, "clientVersion">;
  try {
    token = await resolver.getToken();
  } catch (error) {
    throw credentialError(error);
  }
  const callInput: CodexRealtimeCallInput = {
    ...input.request,
    sessionId: input.sessionId,
    initialItems,
    instructions: openGeniRealtimeInstructions(input.request.instructions),
  };
  try {
    return await deps.createCall({ ...token, clientVersion: CODEX_CLIENT_VERSION }, callInput, {
      signal: input.signal,
    });
  } catch (error) {
    if (!(error instanceof CodexRealtimeError) || error.code !== "authentication") {
      throw brokerProviderError(error);
    }
  }

  // A provider 401 is the only replay-safe credential lifecycle exception: the
  // call was rejected before authentication, so force exactly one refresh and
  // repeat the same SDP request once. No other provider outcome is retried.
  try {
    token = await resolver.refresh();
  } catch (error) {
    throw credentialError(error);
  }
  try {
    return await deps.createCall({ ...token, clientVersion: CODEX_CLIENT_VERSION }, callInput, {
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof CodexRealtimeError && error.code === "authentication") {
      throw new CodexRealtimeBrokerError(
        "reconnect_required",
        "Codex subscription must be reconnected for realtime",
        error.providerStatus,
      );
    }
    throw brokerProviderError(error);
  }
}

/** Bind the pure broker to OpenGeni's encrypted DB credential lifecycle. */
export function buildSessionCodexRealtimeBroker(
  db: Database,
  settings: Settings,
  workspaceId: string,
  sessionId: string,
  fetchImpl: CodexFetch = fetch,
): (input: Omit<CodexRealtimeBrokerInput, "sessionId">) => Promise<CodexRealtimeProviderAnswer> {
  return async (input) =>
    await brokerSessionCodexRealtime(
      {
        enabled: settings.codexSubscriptionEnabled,
        loadSelection: async () => {
          const [sessionState, status, accounts] = await Promise.all([
            getSessionCodexState(db, workspaceId, sessionId),
            getCodexCredentialStatus(db, workspaceId),
            listCodexAccountStatuses(db, workspaceId),
          ]);
          if (!sessionState) {
            throw new CodexRealtimeBrokerError(
              "credential_unavailable",
              "Session is unavailable for Codex realtime",
            );
          }
          return {
            pinnedCredentialId: sessionState.pinnedCredentialId,
            activeCredentialId: status?.credentialId ?? null,
            connectedCredentialIds: new Set(
              accounts
                .filter((account) => account.status === "active")
                .map((account) => account.id),
            ),
          };
        },
        loadInitialItems: async () => {
          const [history, continuity] = await Promise.all([
            getActiveSessionHistoryItems(db, workspaceId, sessionId),
            getSessionRealtimeContinuityEntries(db, workspaceId, sessionId),
          ]);
          return projectSessionRealtimeInitialItems(history, continuity);
        },
        tokenResolver: (credentialId) =>
          buildCodexTokenResolver(db, settings, workspaceId, credentialId),
        createCall: async (auth, callInput, options) =>
          await createCodexRealtimeCall(auth, callInput, fetchImpl, options),
      },
      { ...input, sessionId },
    );
}

function credentialError(error: unknown): CodexRealtimeBrokerError {
  if (error instanceof CodexReloginRequired) {
    return new CodexRealtimeBrokerError(
      "reconnect_required",
      "Codex subscription must be reconnected for realtime",
    );
  }
  return new CodexRealtimeBrokerError(
    "credential_unavailable",
    "Codex subscription credential is unavailable",
  );
}

function brokerProviderError(error: unknown): CodexRealtimeBrokerError {
  if (!(error instanceof CodexRealtimeError)) {
    return new CodexRealtimeBrokerError("network_error", "Codex realtime provider request failed");
  }
  const reason: CodexRealtimeBrokerFailureReason =
    error.code === "invalid_request"
      ? "invalid_request"
      : error.code === "incompatible"
        ? "incompatible"
        : error.code === "authentication"
          ? "reconnect_required"
          : error.code === "entitlement"
            ? "entitlement_denied"
            : error.code === "rate_limited"
              ? "rate_limited"
              : error.code === "invalid_response"
                ? "invalid_provider_response"
                : error.code === "timeout"
                  ? "timeout"
                  : error.code === "cancelled"
                    ? "cancelled"
                    : error.code === "network"
                      ? "network_error"
                      : "provider_error";
  return new CodexRealtimeBrokerError(reason, safeBrokerMessage(reason), error.providerStatus);
}

function safeBrokerMessage(reason: CodexRealtimeBrokerFailureReason): string {
  switch (reason) {
    case "invalid_request":
      return "Codex realtime request is invalid";
    case "incompatible":
      return "Connected Codex subscription is not compatible with realtime V3";
    case "reconnect_required":
      return "Codex subscription must be reconnected for realtime";
    case "entitlement_denied":
      return "Connected Codex subscription does not include realtime access";
    case "rate_limited":
      return "Codex realtime is rate limited";
    case "invalid_provider_response":
      return "Codex realtime returned an incompatible response";
    case "timeout":
      return "Codex realtime negotiation timed out";
    case "cancelled":
      return "Codex realtime negotiation was cancelled";
    case "network_error":
    case "provider_error":
      return "Codex realtime provider request failed";
    case "subscription_disabled":
      return "Connected Codex subscription realtime is disabled";
    case "credential_unavailable":
      return "No connected Codex subscription is available for this session";
  }
}
