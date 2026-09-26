import type { OAuthStartRequest, OAuthStartResponse } from "@/types";

export const MCP_OAUTH_START_TIMEOUT_MS = 20_000;

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
