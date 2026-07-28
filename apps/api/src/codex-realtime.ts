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
        loadInitialItems: async () =>
          projectSessionRealtimeInitialItems(
            await getActiveSessionHistoryItems(db, workspaceId, sessionId),
          ),
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
