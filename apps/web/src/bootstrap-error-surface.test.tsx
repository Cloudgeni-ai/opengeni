import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
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
