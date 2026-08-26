import { describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import {
  AuthApiError,
  authHeadersForAccessKey,
  configureManagedActorEpoch,
  configureClientAuth,
  createOpenGeniClient,
  managedActorMutationBusySnapshot,
  managedActorFetch,
  redeemCodexResetCredit,
  resolveApiBaseUrl,
  signInEmail,
  sendVerificationEmail,
  setStoredAccessKey,
  clearStoredAccessKey,
  completeSelfServiceOrganizationSetup,
  shouldReloadForDeploymentRevision,
  shouldReloadForApiContractRevision,
  subscribeManagedActorInvalidation,
  subscribeManagedActorMutationBusy,
} from "./api";

describe("web API auth helpers", () => {
  test("attaches the accepted actor epoch and rejects a late prior-actor response", async () => {
    const originalFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const observed: { headers?: Headers; signal?: AbortSignal | null } = {};
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observed.headers = new Headers(init?.headers);
      observed.signal = init?.signal ?? null;
      return await pending;
    }) as unknown as typeof fetch;

    try {
      configureManagedActorEpoch("7");
      const result = managedActorFetch("https://api.example.test/v1/workspaces");
      await Promise.resolve();
      expect(observed.headers?.get("x-opengeni-actor-epoch")).toBe("7");
      configureManagedActorEpoch("8");
      expect(observed.signal?.aborted).toBe(true);
      release(
        Response.json([], {
          headers: { "x-opengeni-actor-epoch": "7" },
        }),
      );
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects mismatched server provenance even before a local rotation hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        { ok: true },
        { headers: { "x-opengeni-actor-epoch": "10" } },
      )) as unknown as typeof fetch;
    try {
      configureManagedActorEpoch("9");
      await expect(managedActorFetch("https://api.example.test/v1/access")).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps an established response body actor-bound until the stream closes", async () => {
    const originalFetch = globalThis.fetch;
    const observed: { signal?: AbortSignal | null } = {};
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    try {
      configureManagedActorEpoch("12");
      const response = await managedActorFetch("https://api.example.test/v1/sessions/live");
      const reader = response.body!.getReader();
      const read = reader.read();
      bodyController.enqueue(new TextEncoder().encode("event: ready\n\n"));
      await expect(read).resolves.toMatchObject({ done: false });
      const lateRead = reader.read();
      configureManagedActorEpoch("13");
      expect(observed.signal?.aborted).toBe(true);
      await expect(lateRead).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

  test("defers an actor-abort body error until a downstream reader observes it", async () => {
    const originalFetch = globalThis.fetch;
    const observed: { cancelledWith?: unknown; signal?: AbortSignal | null } = {};
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel(reason) {
            observed.cancelledWith = reason;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      configureManagedActorEpoch("13");
      const response = await managedActorFetch("https://api.example.test/v1/workspaces");
      configureManagedActorEpoch("14");
      expect(observed.signal?.aborted).toBe(true);
      expect(observed.cancelledWith).toMatchObject({ name: "AbortError" });
      await expect(response.json()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

  test("tracks actor-bound mutations through response-body settlement", async () => {
    const originalFetch = globalThis.fetch;
    const snapshots: boolean[] = [];
    const unsubscribe = subscribeManagedActorMutationBusy(() => {
      snapshots.push(managedActorMutationBusySnapshot());
    });
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    try {
      configureManagedActorEpoch("14");
      const response = await managedActorFetch("https://api.example.test/v1/workspaces", {
        method: "POST",
      });
      expect(managedActorMutationBusySnapshot()).toBe(true);
      await response.json();
      expect(managedActorMutationBusySnapshot()).toBe(false);
      expect(snapshots).toEqual([true, false]);
    } finally {
      unsubscribe();
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

  test("publishes server-signaled actor loss for neutral reconciliation", async () => {
    const originalFetch = globalThis.fetch;
    let invalidations = 0;
    const unsubscribe = subscribeManagedActorInvalidation(() => {
      invalidations += 1;
    });
    globalThis.fetch = (async () =>
      Response.json(
        { error: { details: { managedAuthCode: "actor_change_required" } } },
        { status: 409, headers: { "x-opengeni-actor-state": "changed" } },
      )) as unknown as typeof fetch;
    try {
      configureManagedActorEpoch("15");
      const response = await managedActorFetch("https://api.example.test/v1/access");
      expect(response.status).toBe(409);
      expect(invalidations).toBe(1);
      await response.json();
    } finally {
      unsubscribe();
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
    }
  });

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
      authHeadersForAccessKey("secret", {
        mode: "managedSession",
        session: "cookie",
      }),
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
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
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
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      email: "user@example.com",
    });
    expect(new Headers(request!.init?.headers).get("x-opengeni-api-contract")).toBe(
      OPENGENI_API_CONTRACT_REVISION,
    );
  });

  test("sends the exact API contract revision on product-owned auth mutations", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json({
        status: "complete",
        organizationId: crypto.randomUUID(),
        personalWorkspaceId: crypto.randomUUID(),
      });
    }) as unknown as typeof fetch;

    try {
      await completeSelfServiceOrganizationSetup({
        organizationName: "Northwind Research",
        operationId: crypto.randomUUID(),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(String(requests[0]!.input)).toBe("/v1/auth/organization-onboarding");
    expect(new Headers(requests[0]!.init?.headers).get("x-opengeni-api-contract")).toBe(
      OPENGENI_API_CONTRACT_REVISION,
    );
  });

  test("parses Better Auth failures into structured errors without raw JSON prefixes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        {
          message: "[body.email] Invalid email address",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      )) as unknown as typeof fetch;

    try {
      await signInEmail({ email: "invalid", password: "password" });
      throw new Error("Expected sign-in to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthApiError);
      expect(error).toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
        field: "email",
        message: "Invalid email address",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends the API contract header on managed-session mutations", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json({
        status: "completed",
        attemptId: "attempt-id",
        outcome: "reset",
        overview: null,
      });
    }) as unknown as typeof fetch;

    try {
      await expect(
        redeemCodexResetCredit("workspace-id", "account-id", {
          attemptId: "attempt-id",
          creditId: "credit-id",
          confirmationToken: "confirmation-token",
          confirmation: "REDEEM_USAGE_LIMIT_RESET",
        }),
      ).resolves.toMatchObject({ status: "completed", outcome: "reset" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = requests[0];
    expect(request).toBeDefined();
    expect(String(request!.input)).toBe(
      "/v1/workspaces/workspace-id/codex/accounts/account-id/reset-credits/redeem",
    );
    expect(request!.init?.credentials).toBe("include");
    expect(new Headers(request!.init?.headers).get("x-opengeni-api-contract")).toBe(
      OPENGENI_API_CONTRACT_REVISION,
    );
    expect(new Headers(request!.init?.headers).get("authorization")).toBeNull();
    expect(new Headers(request!.init?.headers).get("x-opengeni-access-key")).toBeNull();
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
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json([]);
    }) as unknown as typeof fetch;
    configureClientAuth({
      mode: "deploymentKey",
      headerName: "x-opengeni-access-key",
    });
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
      OPENGENI_API_CONTRACT_REVISION,
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
    configureClientAuth({
      mode: "deploymentKey",
      headerName: "x-opengeni-access-key",
    });

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

  test("preserves credential-free signed object-storage uploads", async () => {
    const restoreLocalStorage = installTestLocalStorage();
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ input, init });
      const url = String(input);
      if (url.endsWith("/files/uploads")) {
        return Response.json(
          {
            fileId: "55555555-5555-4555-8555-555555555555",
            uploadId: "66666666-6666-4666-8666-666666666666",
            putUrl: "https://storage.example.test/container/file.txt?sig=opaque",
            requiredHeaders: { "content-type": "text/plain" },
            expiresAt: "2026-08-01T12:00:00.000Z",
            maxSizeBytes: 1024,
          },
          { status: 201 },
        );
      }
      if (url.startsWith("https://storage.example.test/")) {
        return new Response(null, { status: 201 });
      }
      if (url.endsWith("/files/uploads/66666666-6666-4666-8666-666666666666/complete")) {
        return Response.json({
          file: {
            id: "55555555-5555-4555-8555-555555555555",
            status: "ready",
            filename: "file.txt",
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    try {
      configureManagedActorEpoch("11");
      const client = createOpenGeniClient();
      await client.uploadFile("workspace-id", {
        filename: "file.txt",
        contentType: "text/plain",
        data: "hello",
      });
    } finally {
      configureManagedActorEpoch(null);
      globalThis.fetch = originalFetch;
      restoreLocalStorage();
    }

    expect(requests).toHaveLength(3);
    expect(requests[0]!.init?.credentials).toBe("include");
    expect(requests[1]!.init?.credentials).toBe("omit");
    expect(requests[2]!.init?.credentials).toBe("include");
    expect(new Headers(requests[0]!.init?.headers).get("x-opengeni-actor-epoch")).toBe("11");
    expect(new Headers(requests[1]!.init?.headers).has("x-opengeni-actor-epoch")).toBe(false);
    expect(new Headers(requests[2]!.init?.headers).get("x-opengeni-actor-epoch")).toBe("11");
  });
});
