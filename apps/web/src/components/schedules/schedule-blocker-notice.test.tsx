import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { ScheduleBlockerNotice } = await import("./schedule-blocker-notice");

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, unmount: () => act(async () => root.unmount()) };
}

const base = {
  reason: "scheduled_session_paused",
  message:
    "Its chat is paused, so no run can start there. Resume the chat, then resume the schedule.",
  runId: crypto.randomUUID(),
  since: "2026-10-16T06:00:00.000Z",
};

test("a self-paused schedule says so, explains what unblocks it and opens the chat", async () => {
  let opened = 0;
  const { host, unmount } = await render(
    <ScheduleBlockerNotice blocker={{ ...base, state: "paused" }} onOpenChat={() => opened++} />,
  );
  expect(host.textContent).toContain("Paused itself");
  expect(host.textContent).toContain("Resume the chat, then resume the schedule.");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open chat");
  await act(async () => button?.click());
  expect(opened).toBe(1);
  await unmount();
});

test("a schedule whose owner was told keeps running and shows no chat button without access", async () => {
  const { host, unmount } = await render(
    <ScheduleBlockerNotice
      blocker={{
        ...base,
        state: "notified",
        reason: "scheduled_session_not_idle",
        message: "The last 3 scheduled runs were skipped because its chat was still busy.",
      }}
    />,
  );
  expect(host.textContent).toContain("Needs attention");
  expect(host.textContent).toContain("still busy");
  expect(host.querySelector("button")).toBeNull();
  await unmount();
});
