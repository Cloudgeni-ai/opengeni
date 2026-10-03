import { expect, test } from "bun:test";
import type { BrowserCdpConnection, CdpEvent } from "../src";
import { navigateToInterceptedMetadataDocument } from "../src/browser-metadata";

for (const failure of [
  "paused_timeout",
  "missing_identity",
  "unexpected_url",
  "fulfill_failure",
] as const) {
  test(`metadata interception cancels navigation and retains network fence on ${failure}`, async () => {
    const calls: string[] = [];
    let navigationAborted = false;
    const connection: BrowserCdpConnection = {
      async send<T>(
        method: string,
        _params?: Readonly<Record<string, unknown>>,
        options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
      ): Promise<T> {
        calls.push(method);
        if (method === "Page.navigate") {
          expect(options?.timeoutMs).toBe(5_000);
          return await new Promise<T>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                navigationAborted = true;
                reject(new Error("navigation aborted"));
              },
              { once: true },
            );
          });
        }
        if (method === "Fetch.fulfillRequest" && failure === "fulfill_failure")
          throw new Error("fulfill failed");
        return {} as T;
      },
      async waitForEvent(method: string, options): Promise<CdpEvent> {
        if (method === "Page.loadEventFired") {
          return await new Promise<CdpEvent>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("load aborted")), {
              once: true,
            });
          });
        }
        if (failure === "paused_timeout") throw new Error("paused event timed out");
        return {
          method,
          params: {
            ...(failure === "missing_identity" ? {} : { requestId: "private-request" }),
            request: {
              url:
                failure === "unexpected_url"
                  ? "https://untrusted.example/"
                  : "http://localhost/__opengeni_browser_metadata__",
            },
          },
          sessionId: "private-target",
        };
      },
      on: () => () => undefined,
      close() {},
    };
    const started = Date.now();
    await expect(
      navigateToInterceptedMetadataDocument(connection, "private-target"),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(navigationAborted).toBe(true);
    expect(calls).not.toContain("Fetch.continueRequest");
    expect(calls).not.toContain("Fetch.disable");
    if (failure === "unexpected_url") expect(calls).toContain("Fetch.failRequest");
  });
}
