import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWaitStatus } from "./session-wait-status";
import type { Session } from "@opengeni/sdk";
const session = {
  status: "idle",
  effectiveControl: { state: "active" },
  inputWait: {
    reason: "Waiting for the build checks to finish.",
    deadlineAt: "2099-09-09T14:00:00Z",
  },
} as Session;
test("queued dispatch retries explain absent execution without a working spinner", () => {
  const queued = {
    ...session,
    status: "queued" as const,
    activeTurnId: null,
    inputWait: null,
    dispatchWait: {
      state: "pending" as const,
      attempts: 42,
      nextAttemptAt: "2099-09-09T14:00:00Z",
      lastError: null,
    },
  };
  const html = renderToStaticMarkup(<SessionWaitStatus session={queued} />);
  expect(html).toContain("Still waiting to start");
  expect(html).toContain("No agent turn is running");
  expect(html).toContain("Automatic start retry at");
  expect(html).toContain("42 dispatch attempts");
  expect(html).not.toContain("animate-spin");
  const failed = renderToStaticMarkup(
    <SessionWaitStatus
      session={{
        ...queued,
        dispatchWait: { ...queued.dispatchWait, lastError: "Control worker unavailable" },
      }}
    />,
  );
  expect(failed).toContain("Control worker unavailable");
  expect(failed).toContain("Unable to start yet");
  for (const next of [
    { ...queued, status: "running" as const },
    { ...queued, activeTurnId: "new-turn" },
    { ...queued, effectiveControl: { ...queued.effectiveControl, state: "paused" as const } },
  ])
    expect(renderToStaticMarkup(<SessionWaitStatus session={next} />)).toBe("");
});
test("accepted dispatch and absent telemetry do not claim execution or automatic retry", () => {
  for (const state of ["acknowledged", "unavailable"] as const) {
    const html = renderToStaticMarkup(
      <SessionWaitStatus
        session={{
          ...session,
          status: "queued",
          activeTurnId: null,
          dispatchWait: { state, attempts: 0, nextAttemptAt: null, lastError: null },
        }}
      />,
    );
    expect(html).toContain("No agent turn is running");
    expect(html).not.toContain("Automatic start retry");
  }
});
test("active wait lives near composer and exposes its next check", () => {
  const html = renderToStaticMarkup(<SessionWaitStatus session={session} />);
  expect(html).toContain(session.inputWait!.reason);
  expect(html).toContain("Checks again at");
  expect(html).toContain("resumes sooner");
});
test("running, paused, and cleared waits do not display stale status", () => {
  for (const next of [
    { ...session, status: "running" as const },
    { ...session, inputWait: null },
    { ...session, effectiveControl: { ...session.effectiveControl, state: "paused" as const } },
  ]) {
    expect(renderToStaticMarkup(<SessionWaitStatus session={next as Session} />)).toBe("");
  }
});
test("expired deadline remains a wait until durable state changes", () => {
  expect(
    renderToStaticMarkup(
      <SessionWaitStatus
        session={{
          ...session,
          inputWait: { ...session.inputWait!, deadlineAt: "2000-01-01T00:00:00Z" },
        }}
      />,
    ),
  ).toContain("Recheck due");
});
test("legacy internal notes are preserved in disclosure", () => {
  const reason = "Raw internal bookkeeping ".repeat(20);
  const html = renderToStaticMarkup(
    <SessionWaitStatus session={{ ...session, inputWait: { ...session.inputWait!, reason } }} />,
  );
  expect(html).toContain("Waiting for work in progress");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain(reason.trim());
});
