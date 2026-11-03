import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

if (!globalThis.document) GlobalRegistrator.register();
const { CalendarRemindersRow } = await import("./calendar-reminders-row");
const { CalendarRemindersNotice } = await import("../meetings/calendar-reminders-offer");
const { connectCalendarPath } = await import("./use-meeting-detection");
afterAll(() => GlobalRegistrator.unregister());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

async function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
}

function button(name: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(name),
  ) as HTMLButtonElement | undefined;
}

const status = { enabled: true, available: true, calendarReminders: true } as const;

describe("Remind me before meetings", () => {
  test("without a calendar, says what it needs and offers one link to connect one", async () => {
    const connects: string[] = [];
    await render(
      <CalendarRemindersRow
        status={{ ...status, calendar: "none" }}
        onChange={() => undefined}
        onConnectCalendar={() => connects.push("connect")}
      />,
    );
    expect(host.textContent).toContain("Connect Google Calendar or Outlook");
    await act(async () => button("Connect calendar")!.click());
    expect(connects).toEqual(["connect"]);
  });

  test("with a calendar, or turned off, has no link to connect one", async () => {
    await render(
      <CalendarRemindersRow
        status={{ ...status, calendar: "connected" }}
        onChange={() => undefined}
        onConnectCalendar={() => undefined}
      />,
    );
    expect(host.textContent).toContain("join it and start recording");
    expect(button("Connect calendar")).toBeUndefined();
    await act(async () =>
      root.render(
        <CalendarRemindersRow
          status={{ ...status, calendarReminders: false, calendar: "none" }}
          onChange={() => undefined}
          onConnectCalendar={() => undefined}
        />,
      ),
    );
    expect(host.textContent).toContain("Off.");
    expect(button("Connect calendar")).toBeUndefined();
  });

  test("the switch turns reminders off", async () => {
    const changes: boolean[] = [];
    await render(
      <CalendarRemindersRow
        status={{ ...status, calendar: "connected" }}
        onChange={(on) => changes.push(on)}
      />,
    );
    await act(async () => (host.querySelector("[role=switch]") as HTMLElement).click());
    expect(changes).toEqual([false]);
  });
});

describe("The offer on Meetings", () => {
  test("has one action to connect a calendar and a way to close it for good", async () => {
    const seen: string[] = [];
    await render(
      <CalendarRemindersNotice
        onConnect={() => seen.push("connect")}
        onDismiss={() => seen.push("dismiss")}
      />,
    );
    await act(async () => button("Connect calendar")!.click());
    await act(async () =>
      (host.querySelector('[aria-label="Don\'t show again"]') as HTMLElement).click(),
    );
    expect(seen).toEqual(["connect", "dismiss"]);
  });

  test("connects on the workspace's Capabilities page", () => {
    expect(connectCalendarPath("ws 1")).toBe("/workspaces/ws%201/plugins");
  });
});
