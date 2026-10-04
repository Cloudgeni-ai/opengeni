import { describe, expect, test } from "bun:test";
import { CLIENT_PAGES, CLIENT_REQUEST_ACTIONS } from "@opengeni/contracts/client-error-report";

import { journeyPageLabels } from "./analytics-journey";
import { beaconSender } from "./client-error-reporting";
import {
  clientRequestAction,
  clientRequestFailureReason,
  createClientSignalReporter,
} from "./client-signals";

const W = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const S = "0b4f8f3e-3c55-4a8b-9a3e-2f43d93a9c11";

describe("request action classification", () => {
  test("maps exact key mutation paths to closed actions", () => {
    const cases: Array<[string, string, string | null]> = [
      [`/v1/workspaces/${W}/sessions`, "POST", "create_session"],
      [`/v1/workspaces/${W}/sessions/${S}/events`, "POST", "send_message"],
      [`/v1/workspaces/${W}/sessions/${S}/steer`, "POST", "steer_message"],
      [`/v1/workspaces/${W}/sessions/${S}/queue/${S}/steer`, "POST", "steer_message"],
      [`/v1/workspaces/${W}/sessions/${S}/composer-draft/submit`, "POST", "composer_submit"],
      [`/v1/workspaces/${W}/sessions/${S}/retry`, "POST", "retry_turn"],
      [`/v1/workspaces/${W}/connections`, "POST", "connect_integration"],
      [`/v1/workspaces/${W}/codex/connect/start`, "POST", "connect_model"],
      [`/v1/organizations/${W}/model-providers/anthropic`, "PUT", "connect_model"],
      [`/v1/organizations/${W}/supergrok/connect/start`, "POST", "connect_model"],
      ["/v1/billing/checkout", "POST", "checkout_start"],
      [`/v1/workspaces/${W}/sessions/${S}/events`, "GET", null],
      [`/v1/workspaces/${W}/sessions/${S}/events/stream`, "POST", null],
      [`/v1/workspaces/not-a-uuid/sessions`, "POST", null],
      ["/v1/client-errors", "POST", null],
    ];
    for (const [path, method, action] of cases) {
      expect(clientRequestAction(path, method)).toBe(action as never);
    }
  });

  test("classifies only transport failures and never cancellations", () => {
    expect(clientRequestFailureReason(new TypeError("Failed to fetch"), true)).toBe("network");
    expect(clientRequestFailureReason(new TypeError("Failed to fetch"), false)).toBe("offline");
    expect(
      clientRequestFailureReason(new DOMException("Request timed out", "TimeoutError"), true),
    ).toBe("timeout");
    expect(clientRequestFailureReason(new DOMException("stop", "AbortError"), true)).toBeNull();
    expect(clientRequestFailureReason(new DOMException("stop", "AbortError"), false)).toBeNull();
    expect(clientRequestFailureReason(new Error("HTTP 500"), true)).toBeNull();
  });
});

describe("signal reporter", () => {
  test("projects closed reports and bounds repeats", () => {
    let now = 0;
    const sent: unknown[] = [];
    const reporter = createClientSignalReporter({
      send: (body) => sent.push(JSON.parse(body)),
      revision: "abc123",
      routePattern: () => `/workspaces/${W}`,
      now: () => now,
      maxReportsPerWindow: 3,
    });
    expect(reporter.requestFailure("send_message", "offline")).toBe(true);
    expect(reporter.requestFailure("send_message", "offline")).toBe(false);
    now += 30_000;
    expect(reporter.requestFailure("send_message", "offline")).toBe(true);
    expect(reporter.stream("session", "reconnect")).toBe(true);
    // The window cap applies across signals.
    expect(reporter.stream("workspace", "reconnect")).toBe(false);
    expect(reporter.webVital("lcp", "sessions", 2.41234567)).toBe(true);
    expect(reporter.webVital("lcp", "sessions", 1)).toBe(false);
    expect(reporter.webVital("cls", "sessions", 101)).toBe(false);
    expect(sent[0]).toEqual({
      signal: "request_failure",
      action: "send_message",
      reason: "offline",
      // A concrete path never leaves the browser.
      route: "unknown",
      revision: "abc123",
    });
    expect(sent.at(-1)).toEqual({
      signal: "web_vital",
      metric: "lcp",
      page: "sessions",
      value: 2.4123,
      revision: "abc123",
    });
  });

  test("the contract lists every action the classifier can return", () => {
    expect(CLIENT_REQUEST_ACTIONS).toContain("create_session");
  });

  test("the contract page list is exactly the journey page labels", () => {
    expect([...journeyPageLabels()].sort()).toEqual([...CLIENT_PAGES].sort());
  });
});

describe("beacon delivery while offline", () => {
  test("queues while offline and retries once when back online", async () => {
    const target = new EventTarget();
    let online = false;
    let fail = false;
    const posted: string[] = [];
    const send = beaconSender(
      "/v1/client-errors",
      (async (_url: string, init: RequestInit) => {
        posted.push(String(init.body));
        if (fail) throw new TypeError("network down");
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
      { retryTarget: target as never, isOnline: () => online },
    );
    send("a");
    expect(posted).toEqual([]);
    online = true;
    target.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(posted).toEqual(["a"]);
    // A failed send is held and retried exactly once.
    fail = true;
    send("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toEqual(["a", "b", "b"]);
  });
});
