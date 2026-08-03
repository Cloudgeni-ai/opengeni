import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_MODEL,
  CodexRealtimeError,
  type CodexAuthHeaders,
  type CodexRealtimeCallInput,
} from "@opengeni/codex";
import {
  CodexRealtimeBrokerError,
  OPENGENI_REALTIME_BASE_INSTRUCTIONS,
  brokerSessionCodexRealtime,
  openGeniRealtimeInstructions,
  type CodexRealtimeBrokerDependencies,
} from "../src/codex-realtime";

const request = {
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
  version: "v3" as const,
  instructions: "Current session context",
};
const response = {
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
  version: "v3" as const,
  model: CODEX_REALTIME_MODEL,
};
const BEARER_DEFAULT = ["fixture", "bearer", "default"].join("-");
const BEARER_STALE = ["fixture", "bearer", "stale"].join("-");
const BEARER_FRESH = ["fixture", "bearer", "fresh"].join("-");
const ACCESS_TOKEN_FIELD: keyof Omit<CodexAuthHeaders, "clientVersion"> = "accessToken";

function tokenSnapshot(
  value = BEARER_DEFAULT,
  chatgptAccountId = "account-pin",
  isFedramp = false,
): Omit<CodexAuthHeaders, "clientVersion"> {
  return {
    [ACCESS_TOKEN_FIELD]: value,
    chatgptAccountId,
    isFedramp,
  };
}

function dependencies(
  overrides: Partial<CodexRealtimeBrokerDependencies> = {},
): CodexRealtimeBrokerDependencies {
  return {
    enabled: true,
    loadSelection: async () => ({
      pinnedCredentialId: "credential-pin",
      activeCredentialId: "credential-active",
      connectedCredentialIds: new Set(["credential-pin", "credential-active"]),
    }),
    loadInitialItems: async () => [],
    tokenResolver: () => ({
      getToken: async () => tokenSnapshot(),
      refresh: async () => tokenSnapshot(),
    }),
    createCall: async () => response,
    ...overrides,
  };
}

describe("session Codex realtime broker", () => {
  test("binds the session pin and account to a V3 call without returning either identity", async () => {
    let selected: string | null = null;
    let capturedAuth: CodexAuthHeaders | null = null;
    let capturedInput: CodexRealtimeCallInput | null = null;
    const result = await brokerSessionCodexRealtime(
      dependencies({
        tokenResolver: (credentialId) => {
          selected = credentialId;
          return {
            getToken: async () => tokenSnapshot(BEARER_DEFAULT, "account-bound", true),
            refresh: async () => {
              throw new Error("refresh must not run");
            },
          };
        },
        createCall: async (auth, input) => {
          capturedAuth = auth;
          capturedInput = input;
          return response;
        },
      }),
      { sessionId: "session-one", request },
    );

    expect(selected).toBe("credential-pin");
    expect(capturedAuth?.accessToken).toBe(BEARER_DEFAULT);
    expect(capturedAuth?.chatgptAccountId).toBe("account-bound");
    expect(capturedAuth?.isFedramp).toBe(true);
    expect(capturedAuth?.clientVersion).toBe("0.145.0");
    expect(capturedInput).toEqual({
      ...request,
      sessionId: "session-one",
      initialItems: [],
      instructions: openGeniRealtimeInstructions("Current session context"),
    });
    expect(result).toEqual(response);
    expect(JSON.stringify(result)).not.toContain("credential-pin");
    expect(JSON.stringify(result)).not.toContain("account-bound");
    expect(JSON.stringify(result)).not.toContain(BEARER_DEFAULT);
  });

  test("falls back from a disconnected pin to the connected active credential", async () => {
    let selected: string | null = null;
    await brokerSessionCodexRealtime(
      dependencies({
        loadSelection: async () => ({
          pinnedCredentialId: "credential-disconnected",
          activeCredentialId: "credential-active",
          connectedCredentialIds: new Set(["credential-active"]),
        }),
        tokenResolver: (credentialId) => {
          selected = credentialId;
          return dependencies().tokenResolver(credentialId);
        },
      }),
      { sessionId: "session-one", request },
    );
    expect(selected).toBe("credential-active");
  });

  test("adds server-projected history and reuses the exact snapshot on an auth retry", async () => {
    const history = [
      { role: "user" as const, text: "prior request" },
      { role: "assistant" as const, text: "prior answer" },
    ];
    let historyReads = 0;
    const calls: CodexRealtimeCallInput[] = [];
    await brokerSessionCodexRealtime(
      dependencies({
        loadInitialItems: async () => {
          historyReads += 1;
          return history;
        },
        tokenResolver: () => ({
          getToken: async () => tokenSnapshot(BEARER_STALE),
          refresh: async () => tokenSnapshot(BEARER_FRESH),
        }),
        createCall: async (_auth, input) => {
          calls.push(input);
          if (calls.length === 1) {
            throw new CodexRealtimeError("authentication", "rejected", 401);
          }
          return response;
        },
      }),
      { sessionId: "session-one", request },
    );
    expect(historyReads).toBe(1);
    expect(calls).toEqual([
      {
        ...request,
        sessionId: "session-one",
        initialItems: history,
        instructions: openGeniRealtimeInstructions("Current session context"),
      },
      {
        ...request,
        sessionId: "session-one",
        initialItems: history,
        instructions: openGeniRealtimeInstructions("Current session context"),
      },
    ]);
  });

  test("provides unified unbranded realtime and backend instructions", async () => {
    let captured: CodexRealtimeCallInput | null = null;
    await brokerSessionCodexRealtime(
      dependencies({
        createCall: async (_auth, input) => {
          captured = input;
          return response;
        },
      }),
      {
        sessionId: "session-one",
        request: { sdp: request.sdp, version: request.version },
      },
    );

    expect(captured?.instructions).toBe(OPENGENI_REALTIME_BASE_INSTRUCTIONS);
    expect(captured?.instructions).toStartWith(
      "## Identity, tone, and role\n\nYou are the realtime conversational interface for the current session.",
    );
    expect(captured?.instructions).toContain("Treat the system as one unified assistant.");
    expect(captured?.instructions).toContain("For actions or tasks, always use the backend.");
    expect(captured?.instructions).toContain(
      "Do not claim that you cannot perform an action or lack access to tools",
    );
    expect(captured?.instructions).toContain(
      "queued_for_execution means it is waiting behind existing work",
    );
    expect(captured?.instructions).toContain(
      "accepted_for_steering means it was given priority as a change of direction, while any prior work may still be yielding",
    );
    expect(captured?.instructions).not.toContain("OpenGeni");
    expect(captured?.instructions).not.toContain("client delegation");
  });

  test("bounds additional realtime guidance and keeps server rules authoritative", () => {
    const instructions = openGeniRealtimeInstructions("🙂".repeat(20_000));
    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(32_768);
    expect(instructions).toStartWith(OPENGENI_REALTIME_BASE_INSTRUCTIONS);
    expect(instructions).toContain("unless it conflicts with the operating, delegation, safety");
    expect(instructions).not.toContain("�");
  });

  test("forces one refresh after a provider 401, then retries exactly once", async () => {
    let getTokenCalls = 0;
    let refreshCalls = 0;
    const bearerCalls: string[] = [];
    const result = await brokerSessionCodexRealtime(
      dependencies({
        tokenResolver: () => ({
          getToken: async () => {
            getTokenCalls += 1;
            return tokenSnapshot(BEARER_STALE, "account-one");
          },
          refresh: async () => {
            refreshCalls += 1;
            return tokenSnapshot(BEARER_FRESH, "account-one");
          },
        }),
        createCall: async (auth) => {
          bearerCalls.push(auth.accessToken);
          if (bearerCalls.length === 1) {
            throw new CodexRealtimeError("authentication", "rejected", 401);
          }
          return response;
        },
      }),
      { sessionId: "session-one", request },
    );
    expect(result).toEqual(response);
    expect(getTokenCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(bearerCalls).toEqual([BEARER_STALE, BEARER_FRESH]);
  });

  test("turns a second 401 into reconnect-required without another retry", async () => {
    let calls = 0;
    let refreshes = 0;
    const pending = brokerSessionCodexRealtime(
      dependencies({
        tokenResolver: () => ({
          getToken: async () => tokenSnapshot(BEARER_STALE, "account-one"),
          refresh: async () => {
            refreshes += 1;
            return tokenSnapshot(BEARER_FRESH, "account-one");
          },
        }),
        createCall: async () => {
          calls += 1;
          throw new CodexRealtimeError("authentication", "provider body must not escape", 401);
        },
      }),
      { sessionId: "session-one", request },
    );
    await expect(pending).rejects.toMatchObject({
      reason: "reconnect_required",
      providerStatus: 401,
    });
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    try {
      await pending;
    } catch (error) {
      expect(error).toBeInstanceOf(CodexRealtimeBrokerError);
      expect((error as Error).message).not.toContain("provider body");
    }
  });

  test("does not refresh or fall back for entitlement/provider failures", async () => {
    let calls = 0;
    let refreshes = 0;
    const pending = brokerSessionCodexRealtime(
      dependencies({
        tokenResolver: () => ({
          getToken: async () => tokenSnapshot(BEARER_DEFAULT, "account-one"),
          refresh: async () => {
            refreshes += 1;
            throw new Error("not expected");
          },
        }),
        createCall: async () => {
          calls += 1;
          throw new CodexRealtimeError("entitlement", "not entitled", 403);
        },
      }),
      { sessionId: "session-one", request },
    );
    await expect(pending).rejects.toMatchObject({
      reason: "entitlement_denied",
    });
    expect(calls).toBe(1);
    expect(refreshes).toBe(0);
  });

  test("fails closed when disabled or no selected connected credential exists", async () => {
    await expect(
      brokerSessionCodexRealtime(dependencies({ enabled: false }), {
        sessionId: "session-one",
        request,
      }),
    ).rejects.toMatchObject({ reason: "subscription_disabled" });
    await expect(
      brokerSessionCodexRealtime(
        dependencies({
          loadSelection: async () => ({
            pinnedCredentialId: "pin",
            activeCredentialId: "active",
            connectedCredentialIds: new Set(),
          }),
        }),
        { sessionId: "session-one", request },
      ),
    ).rejects.toMatchObject({ reason: "credential_unavailable" });
  });

  test("forwards request cancellation to the provider boundary", async () => {
    const abort = new AbortController();
    let signal: AbortSignal | undefined;
    await brokerSessionCodexRealtime(
      dependencies({
        createCall: async (_auth, _input, options) => {
          signal = options.signal;
          return response;
        },
      }),
      { sessionId: "session-one", request, signal: abort.signal },
    );
    expect(signal).toBe(abort.signal);
  });
});
