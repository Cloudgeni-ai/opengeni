import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";

let App: typeof import("./App").App;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://app.example.test/" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ App } = await import("./App"));
});

beforeEach(() => document.body.replaceChildren());

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("bootstrap error surface", () => {
  test("StrictMode skips config I/O for its discarded effect and aborts the live request on unmount", async () => {
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path !== "/v1/config/client") throw new Error(`Unexpected request: ${path}`);
      signals.push(init!.signal!);
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <App />
          </StrictMode>,
        ),
      );
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
    }
    expect(signals[0]!.aborted).toBe(true);
  });

  test.each([
    { status: 503, body: "unavailable", attempts: 3, title: "OpenGeni is temporarily unavailable" },
    { status: 401, body: "unauthorized", attempts: 1, title: "OpenGeni couldn't start" },
    { status: 403, body: "forbidden", attempts: 1, title: "OpenGeni couldn't start" },
    { status: 500, body: "invalid configuration", attempts: 1, title: "OpenGeni couldn't start" },
    { status: 200, body: "not json", attempts: 1, title: "OpenGeni couldn't start" },
  ])(
    "stops at the terminal configuration surface: %s",
    async ({ status, body, attempts, title }) => {
      jest.useFakeTimers();
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(input), window.location.href).pathname;
        if (path !== "/v1/config/client") throw new Error(`Unexpected request: ${path}`);
        requests++;
        return new Response(body, { status });
      }) as typeof fetch;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<App />));
        expect(requests).toBe(1);
        await act(async () => jest.advanceTimersByTime(500));
        await act(async () => jest.advanceTimersByTime(1_500));
        expect(container.textContent).toContain(title);
        expect(container.querySelector("button")?.textContent).toContain("Try again");
        await act(async () => jest.advanceTimersByTime(60_000));
        expect(requests).toBe(attempts);
      } finally {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
      }
    },
  );

  test.each(["config", "access", "network"])(
    "recovers %s bootstrap without reload",
    async (stage) => {
      jest.useFakeTimers();
      const originalFetch = globalThis.fetch;
      const counts = new Map<string, number>();
      let recovered = false;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(input), window.location.href).pathname;
        const count = (counts.get(path) ?? 0) + 1;
        counts.set(path, count);
        const failingPath = stage === "access" ? "/v1/access/me" : "/v1/config/client";
        if (path === failingPath && !recovered) {
          if (stage === "network") throw new TypeError("Failed to fetch");
          return new Response("upstream unavailable", { status: 503 });
        }
        const payload =
          path === "/v1/config/client"
            ? {
                apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
                deploymentRevision: "",
                managedAuthSessionSetMode: "legacy",
                defaultModel: "gpt-5.6-sol",
                allowedModels: ["gpt-5.6-sol"],
                models: [],
                defaultReasoningEffort: "none",
                allowedReasoningEfforts: ["none"],
                mcpServers: [],
                fileUploads: { enabled: false, maxSizeBytes: 0 },
                productAccessMode: "local",
                auth: { mode: "none" },
                analytics: { consentRequired: true, providers: {} },
                structuredServices: { fileSystem: false, git: false, terminalEvents: false },
              }
            : path === "/v1/access/me"
              ? {
                  subjectId: "test-user",
                  accountGrants: [],
                  workspaceGrants: [],
                  defaultWorkspaceId: null,
                }
              : path === "/v1/workspaces"
                ? []
                : null;
        if (payload === null) throw new Error(`Unexpected request: ${path}`);
        return Response.json(payload);
      }) as typeof fetch;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<App />);
        });
        expect(container.textContent).not.toContain("temporarily unavailable");
        const failingPath = stage === "access" ? "/v1/access/me" : "/v1/config/client";
        const initialRequests = counts.get(failingPath)!;
        recovered = true;
        await act(async () => {
          jest.advanceTimersByTime(500);
        });
        expect(container.textContent).toContain("No workspace access");
        expect(counts.get(failingPath)).toBe(initialRequests + 1);
      } finally {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
      }
    },
  );

  test("shows maintenance copy without the raw payload and retries in place", async () => {
    const originalFetch = globalThis.fetch;
    let configRequests = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname !== "/v1/config/client") {
        throw new Error(`Unexpected request: ${url.pathname}`);
      }
      configRequests += 1;
      return new Response(JSON.stringify({ error: "maintenance" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("OpenGeni is under maintenance");
      expect(container.textContent).toContain("We'll be back shortly");
      expect(container.textContent).not.toContain("API 503");
      expect(container.textContent).not.toContain('{"error":"maintenance"}');
      expect(document.body.textContent?.match(/OpenGeni is under maintenance/gu)).toHaveLength(1);
      expect(configRequests).toBe(1);

      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Try again",
      );
      expect(retry).toBeDefined();

      await act(async () => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(configRequests).toBe(2);
      expect(container.textContent).toContain("OpenGeni is under maintenance");
      expect(container.textContent).not.toContain("API 503");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  });
});
