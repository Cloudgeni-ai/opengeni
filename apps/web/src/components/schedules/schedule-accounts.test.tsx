import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ScheduledTaskAccountPlan } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { ScheduleAccounts, scheduleAccountRowText, scheduleAccountsDescription } =
  await import("./schedule-accounts");

const billing = "11111111-1111-4111-8111-111111111111";
const revoked = "22222222-2222-4222-8222-222222222222";
const slack = "33333333-3333-4333-8333-333333333333";

const plan: ScheduledTaskAccountPlan = {
  connectors: [
    {
      id: "slack",
      name: "Slack",
      mode: "default",
      accounts: [{ connectionId: slack, label: "ana@example.com · Only me", scope: "personal" }],
      unavailablePins: [],
    },
    {
      id: "gmail",
      name: "Gmail",
      mode: "pinned",
      accounts: [],
      unavailablePins: [{ connectionId: revoked }],
    },
    {
      id: "billing",
      name: "Billing",
      mode: "pinned",
      accounts: [{ connectionId: billing, label: "billing@example.com", scope: "shared" }],
      unavailablePins: [],
    },
    { id: "notion", name: "Notion", mode: "default", accounts: [], unavailablePins: [] },
  ],
};

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("schedule accounts", () => {
  test("shows what each connector would use now and offers to unpin a stale pin", async () => {
    const onUseCurrentAccounts = mock((_connectorId: string) => undefined);
    const view = await render(
      <ScheduleAccounts
        plan={plan}
        skipsRuns={false}
        canEdit
        busy={false}
        onUseCurrentAccounts={onUseCurrentAccounts}
      />,
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("ana@example.com · Only me");
      expect(text).toContain("Your current accounts");
      expect(text).toContain("The pinned account can no longer be used. Runs go without Gmail.");
      expect(text).toContain("No account connected. Runs go without Notion.");
      expect(text).toContain("billing@example.comPinned");
      // Only the stale pin offers a reset (a working pin changes in the editor), and the reset names it.
      const buttons = [...view.container.querySelectorAll("button")];
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Use your current Gmail accounts",
      ]);
      await act(async () => buttons[0]!.click());
      expect(onUseCurrentAccounts).toHaveBeenCalledWith("gmail");
    } finally {
      await view.cleanup();
    }
  });

  test("a person who cannot edit sees the plan without actions", async () => {
    const view = await render(
      <ScheduleAccounts
        plan={plan}
        skipsRuns={false}
        canEdit={false}
        busy={false}
        onUseCurrentAccounts={() => undefined}
      />,
    );
    try {
      expect(view.container.querySelectorAll("button")).toHaveLength(0);
    } finally {
      await view.cleanup();
    }
  });

  test("says when a stale pin skips runs and when only some pins are gone", () => {
    expect(scheduleAccountRowText(plan.connectors[1]!, { skipsRuns: true }).note).toBe(
      "The pinned account can no longer be used. Runs are skipped until you change it.",
    );
    expect(
      scheduleAccountRowText(
        {
          id: "gmail",
          name: "Gmail",
          mode: "pinned",
          accounts: [{ connectionId: billing, label: "billing@example.com", scope: "shared" }],
          unavailablePins: [{ connectionId: revoked }],
        },
        { skipsRuns: false },
      ),
    ).toEqual({
      accounts: ["billing@example.com"],
      note: "Pinned. One pinned account can no longer be used.",
      stale: true,
    });
  });

  test("explains Default for chat schedules and schedules with and without pins", () => {
    expect(scheduleAccountsDescription({ runMode: "existing_session" }, plan)).toBe(
      "Runs use the chat's connectors with your current accounts.",
    );
    expect(scheduleAccountsDescription({ runMode: "new_session_per_run" }, plan)).toContain(
      "Pinned connectors use only the accounts you chose.",
    );
    expect(
      scheduleAccountsDescription(
        { runMode: "reusable_session" },
        { connectors: [plan.connectors[0]!] },
      ),
    ).toBe(
      "Each run uses your current accounts, so connecting or removing one counts from the next run.",
    );
  });
});
