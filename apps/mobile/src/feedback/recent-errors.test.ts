import { afterEach, expect, test } from "bun:test";
import { feedbackForOlderServer } from "./outbox-core";
import {
  clearFeedbackRecords,
  feedbackTrail,
  recentErrors,
  recordBreadcrumb,
  recordingRequests,
  sessionIdInScreen,
  setFeedbackScreen,
} from "./recent-errors";

afterEach(clearFeedbackRecords);

const SESSION = "0f7b2a51-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function response(status: number, correlationId?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(correlationId ? { "x-opengeni-correlation-id": correlationId } : {}),
  };
}

test("every server request is remembered with its reference; failed ones are errors too", async () => {
  const statuses = [200, 502, 401];
  const fetch = recordingRequests(async () => response(statuses.shift() ?? 200, "req-1"));
  await fetch("https://api.example/v1/workspaces/w/sessions?token=secret");
  await fetch("https://api.example/v1/workspaces/w/sessions/x", { method: "post" });
  await fetch("https://api.example/v1/me");
  expect(feedbackTrail().recentRequests).toEqual([
    expect.objectContaining({ method: "GET", path: "/v1/workspaces/w/sessions", status: 200 }),
    expect.objectContaining({
      method: "POST",
      path: "/v1/workspaces/w/sessions/x",
      status: 502,
      correlationId: "req-1",
    }),
    expect.objectContaining({ path: "/v1/me", status: 401 }),
  ]);
  // Sign-in expiry is routine, not an error.
  expect(recentErrors().map((error) => error.status)).toEqual([502]);
});

test("an unreachable server is status 0; cancelled requests and sending feedback are left out", async () => {
  const failing = recordingRequests(async () => {
    throw new TypeError("Network request failed");
  });
  await failing("https://api.example/v1/a").catch(() => undefined);
  const cancelled = recordingRequests(async () => {
    throw new DOMException("Aborted", "AbortError");
  });
  await cancelled("https://api.example/v1/b").catch(() => undefined);
  await recordingRequests(async () => response(201))(
    "https://api.example/v1/workspaces/w/feedback",
  );
  expect(feedbackTrail().recentRequests.map((request) => [request.path, request.status])).toEqual([
    ["/v1/a", 0],
  ]);
});

test("screens and app states are steps; the chat in view is found from its screen", () => {
  setFeedbackScreen("/sessions");
  setFeedbackScreen(`/session/${SESSION}`);
  setFeedbackScreen(`/session/${SESSION}`);
  recordBreadcrumb("lifecycle", "App in background");
  expect(feedbackTrail().breadcrumbs.map((crumb) => crumb.label)).toEqual([
    "/sessions",
    `/session/${SESSION}`,
    "App in background",
  ]);
  expect(sessionIdInScreen(`/session/${SESSION}`)).toBe(SESSION);
  expect(sessionIdInScreen(`/meeting/${SESSION}`)).toBeUndefined();
  expect(sessionIdInScreen(null)).toBeUndefined();
});

test("a server older than the app gets the report without the context it doesn't know", () => {
  const request = {
    idempotencyKey: "k",
    comment: "hi",
    context: {
      source: "mobile" as const,
      screen: `/session/${SESSION}`,
      sessionId: SESSION,
      breadcrumbs: [{ at: new Date().toISOString(), kind: "navigation" as const, label: "/" }],
    },
  };
  expect(feedbackForOlderServer(request)).toEqual({
    idempotencyKey: "k",
    comment: "hi",
    context: { source: "mobile", screen: `/session/${SESSION}` },
  });
  expect(feedbackForOlderServer({ idempotencyKey: "k", comment: "hi" })).toBeNull();
  expect(
    feedbackForOlderServer({ idempotencyKey: "k", comment: "hi", context: { source: "mobile" } }),
  ).toBeNull();
});
