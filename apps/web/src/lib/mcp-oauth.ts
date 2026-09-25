import type { OAuthStartRequest, OAuthStartResponse } from "@/types";

export const MCP_OAUTH_START_TIMEOUT_MS = 20_000;

const CALLBACK_STAGE_LABELS: Record<string, string> = {
  state_verify: "validating the connection attempt",
  client_lookup: "loading the OAuth client",
  token_exchange: "finishing provider authorization",
  tools_list: "verifying the MCP server",
  persist: "saving the connection",
};

type OAuthStartClient = {
  startConnectionOAuth: (
    workspaceId: string,
    request: OAuthStartRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<OAuthStartResponse>;
};

/**
 * Bound the pre-redirect MCP OAuth request. Browser fetch can otherwise remain
 * pending indefinitely before the API sees a request, leaving the capability
 * sheet's busy state spinning forever with no provider page and no error.
 */
export async function startMcpOAuthWithTimeout(
  client: OAuthStartClient,
  workspaceId: string,
  request: OAuthStartRequest,
  timeoutMs = MCP_OAUTH_START_TIMEOUT_MS,
): Promise<OAuthStartResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await client.startConnectionOAuth(workspaceId, request, {
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Connection setup timed out. Check your network and try again.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const RETRY = " Select Connect to try again.";
const STALE_LINK = "This connection link is no longer valid or was already used.";

/**
 * Plain-language copy for the callback reasons every integration flow shares:
 * the user cancelling at the provider, and a stale or reused callback link.
 * Returns null for anything flow-specific so callers keep their own wording.
 */
export function oauthCallbackReasonMessage(reason: string | null): string | null {
  switch (reason) {
    case "access_denied":
    case "provider_denied":
      return `You cancelled at the provider, so nothing was connected.${RETRY}`;
    case "provider_error":
      return `The provider didn't approve the connection.${RETRY}`;
    case "missing_code":
      return `The provider didn't finish authorization.${RETRY}`;
    case "state_expired":
      return `This connection link expired. Links last 10 minutes.${RETRY}`;
    case "state_invalid":
    case "state_replayed":
      return `${STALE_LINK}${RETRY}`;
    default:
      return null;
  }
}

export function mcpOAuthCallbackFailureMessage(
  stage: string | null,
  reason: string | null,
): string {
  const shared = oauthCallbackReasonMessage(reason);
  if (shared) return shared;
  if (stage === "state_verify") {
    return "This connection attempt expired or was already used. Try connecting again.";
  }
  if (stage === "client_lookup") {
    return "The OAuth client registration changed while connecting. Try again.";
  }
  if (stage === "token_exchange" && reason === "invalid_client") {
    return "The provider rejected the OAuth client registration. Try again; if it continues, the provider configuration needs attention.";
  }
  if (stage === "persist") {
    return reason === "timeout"
      ? "Authorization succeeded, but saving the connection timed out. Nothing was committed; try again."
      : "Authorization succeeded, but OpenGeni couldn't save the connection. Try again.";
  }
  if (reason === "timeout") {
    const label = stage ? CALLBACK_STAGE_LABELS[stage] : null;
    return label
      ? `Connection timed out while ${label}. Try again.`
      : "Connection timed out. Try again.";
  }
  const label = stage ? CALLBACK_STAGE_LABELS[stage] : null;
  return label
    ? `Connection failed while ${label}. Try again.`
    : "Couldn't connect. Please try again.";
}
