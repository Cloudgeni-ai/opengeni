import { describe, expect, test } from "bun:test";
import {
  authHeadersForAccessKey,
  configureClientAuth,
  createOpenGeniClient,
  mintOpenAITranscriptionClientSecret,
  reportOpenAITranscriptionUsage,
  resolveApiBaseUrl,
  sendVerificationEmail,
  settleOpenAITranscriptionGrant,
  setStoredAccessKey,
  clearStoredAccessKey,
  shouldReloadForDeploymentRevision,
  shouldReloadForApiContractRevision,
} from "./api";

describe("web API auth helpers", () => {
  test("builds access key headers only for configured key modes", () => {
    expect(authHeadersForAccessKey(null)).toEqual({});
    expect(authHeadersForAccessKey("secret")).toEqual({});
    expect(
      authHeadersForAccessKey("secret", {
        mode: "configuredToken",
        headerName: "authorization",
        scheme: "bearer",
      }),
    ).toEqual({ authorization: "Bearer secret" });
    expect(
      authHeadersForAccessKey("secret", {
        mode: "deploymentKey",
        headerName: "x-opengeni-access-key",
      }),
    ).toEqual({ "x-opengeni-access-key": "secret" });
    expect(
      authHeadersForAccessKey("secret", { mode: "managedSession", session: "cookie" }),
    ).toEqual({});
  });

  test("defaults to same-origin API paths for deployed web builds", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("");
    expect(resolveApiBaseUrl("https://opengeni.example.com/")).toBe("https://opengeni.example.com");
  });

  test("reloads once when the API revision differs from the web bundle revision", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    expect(
      shouldReloadForDeploymentRevision({ deploymentRevision: "api-sha" }, "web-sha", fakeStorage),
    ).toBe(true);
    expect(
      shouldReloadForDeploymentRevision({ deploymentRevision: "api-sha" }, "web-sha", fakeStorage),
    ).toBe(false);
    expect(
      shouldReloadForDeploymentRevision({ deploymentRevision: "api-sha" }, "api-sha", fakeStorage),
    ).toBe(false);
    expect(
      shouldReloadForDeploymentRevision({ deploymentRevision: "api-sha" }, "", fakeStorage),
    ).toBe(false);
  });

  test("reloads once when the API protocol differs from the compiled client", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    expect(
      shouldReloadForApiContractRevision(
        { apiContractRevision: "next-contract" },
        "current-contract",
        fakeStorage,
      ),
    ).toBe(true);
    expect(
      shouldReloadForApiContractRevision(
        { apiContractRevision: "next-contract" },
        "current-contract",
        fakeStorage,
      ),
    ).toBe(false);
    expect(
      shouldReloadForApiContractRevision(
        { apiContractRevision: "current-contract" },
        "current-contract",
        fakeStorage,
      ),
    ).toBe(false);
  });

  test("sends managed verification resend requests through Better Auth", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json({ status: true });
    }) as unknown as typeof fetch;

    try {
      await expect(sendVerificationEmail({ email: "user@example.com" })).resolves.toEqual({
        status: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = requests[0];
    expect(request).toBeDefined();
    expect(String(request!.input)).toBe("/v1/auth/send-verification-email");
    expect(request!.init?.method).toBe("POST");
    expect(request!.init?.credentials).toBe("include");
    expect(JSON.parse(String(request!.init?.body))).toEqual({ email: "user@example.com" });
  });

  test("mints, meters, and settles transcription through scoped workspace routes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      if (!String(input).endsWith("/client-secret")) return Response.json({ ok: true });
      return Response.json({
        value: "ek_ephemeral",
        expiresAt: 2_000_000_000,
        providerSessionId: "provider-session-1",
        grantId: "33333333-3333-4333-8333-333333333333",
        maxSessionDurationSeconds: 60,
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    try {
      await expect(
        mintOpenAITranscriptionClientSecret(
          "workspace/id",
          {
            sessionId: "11111111-1111-4111-8111-111111111111",
            requestId: "22222222-2222-4222-8222-222222222222:0",
            language: "en",
            diarization: false,
            privacy: {
              retainAudio: false,
              retainTranscript: false,
              trainingAllowed: false,
            },
          },
          controller.signal,
        ),
      ).resolves.toEqual({
        value: "ek_ephemeral",
        expiresAt: 2_000_000_000,
        providerSessionId: "provider-session-1",
        grantId: "33333333-3333-4333-8333-333333333333",
        maxSessionDurationSeconds: 60,
      });
      await reportOpenAITranscriptionUsage("workspace/id", {
        sessionId: "11111111-1111-4111-8111-111111111111",
        grantId: "33333333-3333-4333-8333-333333333333",
        providerSessionId: "provider-session-1",
        providerEventId: "provider-event-1",
        durationSeconds: 1.75,
      });
      await settleOpenAITranscriptionGrant(
        "workspace/id",
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          grantId: "33333333-3333-4333-8333-333333333333",
          providerSessionId: "provider-session-1",
          status: "completed",
        },
        controller.signal,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const mintRequest = requests[0];
    expect(String(mintRequest?.input)).toBe(
      "/v1/workspaces/workspace%2Fid/transcription/client-secret",
    );
    expect(mintRequest?.init?.method).toBe("POST");
    expect(mintRequest?.init?.credentials).toBe("include");
    expect(mintRequest?.init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(mintRequest?.init?.body))).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222:0",
      language: "en",
      diarization: false,
      privacy: {
        retainAudio: false,
        retainTranscript: false,
        trainingAllowed: false,
      },
    });

    const usageRequest = requests[1];
    expect(String(usageRequest?.input)).toBe(
      "/v1/workspaces/workspace%2Fid/transcription/grants/33333333-3333-4333-8333-333333333333/usage",
    );
    expect(JSON.parse(String(usageRequest?.init?.body))).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      providerSessionId: "provider-session-1",
      providerEventId: "provider-event-1",
      durationSeconds: 1.75,
    });

    const settlementRequest = requests[2];
    expect(String(settlementRequest?.input)).toBe(
      "/v1/workspaces/workspace%2Fid/transcription/grants/33333333-3333-4333-8333-333333333333/settle",
    );
    expect(settlementRequest?.init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(settlementRequest?.init?.body))).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      providerSessionId: "provider-session-1",
      status: "completed",
    });
  });
});

// The streaming/reconnect/replay logic itself lives in @opengeni/sdk and is
// tested there; here we pin the console-specific wiring (auth headers +
// cookies on every SDK request, canonical workspace routes).
describe("createOpenGeniClient", () => {
  function installTestLocalStorage(): () => void {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    return () => {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        delete (globalThis as Record<string, unknown>)["localStorage"];
      }
    };
  }

  test("routes SDK calls through canonical workspace paths with cookies and access-key headers", async () => {
    const restoreLocalStorage = installTestLocalStorage();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json([]);
    }) as unknown as typeof fetch;
    configureClientAuth({ mode: "deploymentKey", headerName: "x-opengeni-access-key" });
    setStoredAccessKey("secret-key");

    try {
      const client = createOpenGeniClient();
      await expect(client.listSessions("workspace-id", { limit: 25 })).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      clearStoredAccessKey();
      configureClientAuth({ mode: "none" });
      restoreLocalStorage();
    }

    const request = requests[0];
    expect(request).toBeDefined();
    expect(String(request!.input)).toBe("/v1/workspaces/workspace-id/sessions?limit=25");
    expect(request!.init?.credentials).toBe("include");
    expect(new Headers(request!.init?.headers).get("x-opengeni-access-key")).toBe("secret-key");
    expect(new Headers(request!.init?.headers).get("x-opengeni-api-contract")).toBe(
      "2026-07-session-control-v1",
    );
  });

  test("reads the access key at request time, not at client construction", async () => {
    const restoreLocalStorage = installTestLocalStorage();
    const originalFetch = globalThis.fetch;
    const seenKeys: Array<string | null> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("x-opengeni-access-key"));
      return Response.json([]);
    }) as unknown as typeof fetch;
    configureClientAuth({ mode: "deploymentKey", headerName: "x-opengeni-access-key" });

    try {
      const client = createOpenGeniClient();
      setStoredAccessKey("first-key");
      await client.listSessions("workspace-id");
      setStoredAccessKey("second-key");
      await client.listSessions("workspace-id");
    } finally {
      globalThis.fetch = originalFetch;
      clearStoredAccessKey();
      configureClientAuth({ mode: "none" });
      restoreLocalStorage();
    }

    expect(seenKeys).toEqual(["first-key", "second-key"]);
  });
});
