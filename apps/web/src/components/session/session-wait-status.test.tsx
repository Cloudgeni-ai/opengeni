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
