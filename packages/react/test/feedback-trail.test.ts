import { afterEach, describe, expect, test } from "bun:test";
import { FeedbackContext } from "@opengeni/contracts";

import { webFeedbackContext } from "../src/app/lib/feedback-capture";
import {
  addressWithoutQuery,
  beginFeedbackRequest,
  clearFeedbackTrail,
  feedbackTrail,
  installFeedbackTrail,
  recordFeedbackNavigation,
  sessionIdInPath,
} from "../src/app/lib/feedback-trail";

afterEach(clearFeedbackTrail);

const SESSION = "0f7b2a51-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function fakeWindow(pathname = "/workspaces/w/sessions") {
  const events = new EventTarget();
  const target = {
    location: { pathname },
    document: { visibilityState: "visible" },
    addEventListener: events.addEventListener.bind(events),
    dispatch: (event: Event) => events.dispatchEvent(event),
  };
  return target;
}

function errorEvent(init: Record<string, unknown>, target?: object): Event {
  const event = new Event("error");
  for (const [key, value] of Object.entries(init))
    Object.defineProperty(event, key, { value, enumerable: true });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("feedback trail", () => {
  test("remembers requests by path, status, time and server reference, never the query", () => {
    const finish = beginFeedbackRequest("get", "/v1/workspaces/w/sessions?token=secret");
    finish(503, { correlationId: "req-1" });
    finish(200);
    const [request] = feedbackTrail().recentRequests;
    expect(request).toMatchObject({
      method: "GET",
      path: "/v1/workspaces/w/sessions",
      status: 503,
      correlationId: "req-1",
    });
    expect(request?.durationMs).toBeGreaterThanOrEqual(0);
    expect(feedbackTrail().recentRequests).toHaveLength(1);
  });

  test("a request with no response is status 0; one the app cancelled and sending feedback are left out", () => {
    beginFeedbackRequest("POST", "/v1/workspaces/w/sessions")(null);
    beginFeedbackRequest("GET", "/v1/workspaces/w/sessions")(null, { aborted: true });
    beginFeedbackRequest("POST", "/v1/workspaces/w/feedback")(201);
    expect(feedbackTrail().recentRequests.map((request) => request.status)).toEqual([0]);
  });

  test("keeps the latest twenty requests", () => {
    for (let index = 0; index < 25; index += 1) beginFeedbackRequest("GET", `/v1/r/${index}`)(200);
    const kept = feedbackTrail().recentRequests;
    expect(kept).toHaveLength(20);
    expect(kept[0]?.path).toBe("/v1/r/5");
    expect(kept[19]?.path).toBe("/v1/r/24");
  });

  test("records uncaught errors, unhandled rejections, failed loads and steps", () => {
    const target = fakeWindow();
    installFeedbackTrail(target);
    installFeedbackTrail(target);
    const failure = new TypeError("x is undefined");
    target.dispatch(
      errorEvent({
        message: "Uncaught TypeError: x is undefined",
        error: failure,
        filename: "https://app.example/assets/index.js?v=1",
        lineno: 10,
        colno: 4,
      }),
    );
    target.dispatch(
      errorEvent({}, { tagName: "IMG", src: "https://files.example/a.png?sig=secret" }),
    );
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new Error("Load failed") });
    target.dispatch(rejection);
    const cancelled = new Event("unhandledrejection");
    Object.defineProperty(cancelled, "reason", {
      value: new DOMException("The user aborted a request", "AbortError"),
    });
    target.dispatch(cancelled);
    target.dispatch(new Event("offline"));
    target.dispatch(new Event("online"));
    target.document.visibilityState = "hidden";
    target.dispatch(new Event("visibilitychange"));
    recordFeedbackNavigation(`/workspaces/w/sessions/${SESSION}?tab=files`);
    recordFeedbackNavigation(`/workspaces/w/sessions/${SESSION}`);

    const trail = feedbackTrail();
    expect(trail.recentExceptions).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "Uncaught TypeError: x is undefined",
        source: "https://app.example/assets/index.js:10:4",
        stack: expect.stringContaining("x is undefined"),
      }),
      expect.objectContaining({
        kind: "resource",
        message: "A img failed to load",
        source: "https://files.example/a.png",
      }),
      expect.objectContaining({ kind: "unhandled_rejection", message: "Error: Load failed" }),
    ]);
    expect(trail.breadcrumbs.map((crumb) => [crumb.kind, crumb.label])).toEqual([
      ["navigation", "/workspaces/w/sessions"],
      ["network", "Went offline"],
      ["network", "Back online"],
      ["lifecycle", "Page hidden"],
      ["navigation", `/workspaces/w/sessions/${SESSION}`],
    ]);
  });

  test("finds the chat in view and strips addresses to what is safe to send", () => {
    expect(sessionIdInPath(`/workspaces/w/sessions/${SESSION.toUpperCase()}`)).toBe(SESSION);
    expect(sessionIdInPath(`/workspaces/w/sessions/${SESSION}/files`)).toBe(SESSION);
    expect(sessionIdInPath("/workspaces/w/sessions")).toBeUndefined();
    expect(addressWithoutQuery("data:image/png;base64,AAAA")).toBe("data:");
    expect(addressWithoutQuery("/a/b#c")).toBe("/a/b");
  });

  test("a report's context carries the trail and is what the server accepts", () => {
    const target = fakeWindow();
    installFeedbackTrail(target);
    beginFeedbackRequest("GET", "/v1/workspaces/w/sessions")(200, { correlationId: "req-2" });
    target.dispatch(errorEvent({ message: "boom", error: new Error("boom") }));
    const context = webFeedbackContext({ serverVersion: "1.2.3" });
    expect(context.recentRequests).toHaveLength(1);
    expect(context.recentExceptions).toHaveLength(1);
    expect(context.breadcrumbs?.length).toBeGreaterThan(0);
    expect(FeedbackContext.safeParse(context).success).toBe(true);
  });
});
