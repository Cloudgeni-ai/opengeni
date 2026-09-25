import { describe, expect, test } from "bun:test";

import {
  mcpOAuthCallbackFailureMessage,
  oauthCallbackReasonMessage,
  startMcpOAuthWithTimeout,
} from "./mcp-oauth";

const request = {
  mcpUrl: "https://mcp.linear.app/mcp",
  providerDomain: "linear.app",
  returnPath: "/capabilities?connect_item=linear",
};

describe("startMcpOAuthWithTimeout", () => {
  test("returns the provider authorization URL and clears the deadline", async () => {
    let signal: AbortSignal | undefined;
    const result = await startMcpOAuthWithTimeout(
      {
        startConnectionOAuth: async (_workspaceId, _request, options) => {
          signal = options?.signal;
          return {
            state: "signed-state",
            authorizationUrl: "https://mcp.linear.app/authorize",
            expiresAt: "2026-07-31T05:30:00.000Z",
          };
        },
      },
      "workspace-1",
      request,
      10,
    );

    expect(result.authorizationUrl).toBe("https://mcp.linear.app/authorize");
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(false);
  });

  test("aborts a stalled browser request and returns actionable copy", async () => {
    let signal: AbortSignal | undefined;
    const stalled = startMcpOAuthWithTimeout(
      {
        startConnectionOAuth: (_workspaceId, _request, options) => {
          signal = options?.signal;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")), {
              once: true,
            });
          });
        },
      },
      "workspace-1",
      request,
      5,
    );

    await expect(stalled).rejects.toThrow(
      "Connection setup timed out. Check your network and try again.",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("preserves a real API error before the deadline", async () => {
    const failure = new Error("integrations are not enabled");
    await expect(
      startMcpOAuthWithTimeout(
        {
          startConnectionOAuth: async () => {
            throw failure;
          },
        },
        "workspace-1",
        request,
        50,
      ),
    ).rejects.toBe(failure);
  });
});

describe("mcpOAuthCallbackFailureMessage", () => {
  test("explains the exact timed-out stage without exposing raw provider text", () => {
    expect(mcpOAuthCallbackFailureMessage("token_exchange", "timeout")).toBe(
      "Connection timed out while finishing provider authorization. Try again.",
    );
  });

  test("makes rollback-safe persistence failures explicit", () => {
    expect(mcpOAuthCallbackFailureMessage("persist", "timeout")).toContain("Nothing was committed");
  });

  test("a provider Cancel is a refusal, not an expired attempt", () => {
    for (const reason of ["access_denied", "provider_denied"]) {
      const message = mcpOAuthCallbackFailureMessage("authorize", reason);
      expect(message).toBe(
        "You cancelled at the provider, so nothing was connected. Select Connect to try again.",
      );
      expect(message).not.toContain("expired");
    }
  });

  test("tells an expired link apart from an invalid or reused one, with a retry step", () => {
    expect(mcpOAuthCallbackFailureMessage("state_verify", "state_expired")).toBe(
      "This connection link expired. Links last 10 minutes. Select Connect to try again.",
    );
    const invalid = mcpOAuthCallbackFailureMessage("state_verify", "state_invalid");
    expect(invalid).toContain("no longer valid or was already used");
    expect(invalid).toContain("Select Connect to try again.");
    expect(oauthCallbackReasonMessage("state_replayed")).toBe(invalid);
  });

  test("leaves flow-specific reasons to each caller", () => {
    expect(oauthCallbackReasonMessage("scope_not_granted")).toBeNull();
    expect(oauthCallbackReasonMessage(null)).toBeNull();
    expect(oauthCallbackReasonMessage("constructor")).toBeNull();
  });

  test("turns an invalid client response into administrator-actionable guidance", () => {
    const message = mcpOAuthCallbackFailureMessage("token_exchange", "invalid_client");
    expect(message).toContain("provider rejected the OAuth client registration");
    expect(message).toContain("provider configuration needs attention");
  });
});
