// Browser-level checks in a DOM: a key request that never reaches the server
// queues a content-free beacon while offline and delivers it once online, and
// a provider OAuth error return is snapshotted at boot before the route
// handler strips it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const W = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const S = "0b4f8f3e-3c55-4a8b-9a3e-2f43d93a9c11";

beforeAll(() => {
  GlobalRegistrator.register({
    url: `https://app.opengeni.test/workspaces/${W}/plugins?integration_oauth=error&stage=authorize&reason=access_denied`,
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("failure signals in the browser", () => {
  test("an offline send queues one beacon and delivers it when back online", async () => {
    const { managedActorFetch } = await import("../api");
    const { beaconSender } = await import("./client-error-reporting");
    const { createClientSignalReporter, setClientSignalReporter } =
      await import("./client-signals");
    const beacons: Array<{ url: string; init: RequestInit }> = [];
    let online = false;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    setClientSignalReporter(
      createClientSignalReporter({
        send: beaconSender(
          "/v1/client-errors",
          (async (url: string, init: RequestInit) => {
            beacons.push({ url, init });
            return new Response(null, { status: 204 });
          }) as unknown as typeof fetch,
          { retryTarget: window },
        ),
        revision: "rev1",
        routePattern: () => "/workspaces/$workspaceId/sessions/$sessionId",
      }),
    );
    const originalFetch = globalThis.fetch;
    // Like a browser: an aborted signal rejects with its reason, otherwise the
    // transport fails without any HTTP response.
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    try {
      await expect(
        managedActorFetch(`/v1/workspaces/${W}/sessions/${S}/events`, {
          method: "POST",
          body: JSON.stringify({ type: "user.message", text: "private prompt" }),
        }),
      ).rejects.toThrow("Failed to fetch");
      // A cancelled request is never counted.
      const cancelled = new AbortController();
      cancelled.abort(new DOMException("stop", "AbortError"));
      await managedActorFetch(`/v1/workspaces/${W}/sessions`, {
        method: "POST",
        signal: cancelled.signal,
      }).catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(beacons).toHaveLength(0);
    online = true;
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      keepalive: true,
    });
    const body = String(beacons[0]!.init.body);
    expect(JSON.parse(body)).toEqual({
      signal: "request_failure",
      action: "send_message",
      reason: "offline",
      route: "/workspaces/$workspaceId/sessions/$sessionId",
      revision: "rev1",
    });
    expect(body).not.toContain("private prompt");
    expect(body).not.toContain(W);
  });

  test("an OAuth error return is reported as denied for the redirected class", async () => {
    const { retainIntegrationConnectReturn } = await import("./integration-connect-return");
    const { beginIntegrationConnect, captureIntegrationConnectReturn } =
      await import("./integration-connect-analytics");
    // The redirect started from this tab before the provider sent it back.
    beginIntegrationConnect("atlassian", "oauth", { capture: () => true }).redirecting();
    retainIntegrationConnectReturn(window.location.search);
    // The route handler strips the parameters before analytics loads.
    window.history.replaceState(null, "", `/workspaces/${W}/plugins`);
    const events: Array<[string, Record<string, string>]> = [];
    captureIntegrationConnectReturn({
      capture: (name, properties) => {
        events.push([name, properties]);
        return true;
      },
    });
    expect(events).toEqual([
      [
        "integration_connect_finished",
        { integration_class: "atlassian", method: "oauth", outcome: "denied" },
      ],
    ]);
  });
});
