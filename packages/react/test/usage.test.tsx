import { describe, expect, test } from "bun:test";
import type { MemberAllowanceUsage, WorkspaceUsageResponse } from "@opengeni/sdk/usage-allowances";
import { act } from "react";

import { flush, registerDom, renderComponent, renderHook } from "./render-hook";
import { summarizeUsage, usagePercentLabel } from "../src/usage/summary";

registerDom();
const { UsageMeter, UsageLimitNotice, UsageMemberList, useUsage } = await import("../src/usage");

const RESET = "2026-11-01T00:00:00+00:00";

function member(
  subjectId: string,
  overrides: Partial<MemberAllowanceUsage> = {},
): MemberAllowanceUsage {
  return {
    subjectId,
    externalIdentity: null,
    rule: null,
    version: 0,
    limit: 100_000_000,
    used: 10_000_000,
    remaining: 90_000_000,
    fraction: 0.1,
    status: "ok",
    resetsAt: RESET,
    ...overrides,
  };
}

function usage(
  members: MemberAllowanceUsage[],
  workspace: Partial<WorkspaceUsageResponse["workspace"]> = {},
): WorkspaceUsageResponse {
  return {
    period: { start: "2026-10-01T00:00:00+00:00", end: RESET },
    workspace: {
      limit: 600_000_000,
      used: 60_000_000,
      remaining: 540_000_000,
      fraction: 0.1,
      status: "ok",
      resetsAt: RESET,
      includedCredits: 600_000_000,
      grantsRemaining: 0,
      ...workspace,
    },
    members,
    nextCursor: null,
  };
}

describe("summarizeUsage", () => {
  test("no ceilings is unlimited", () => {
    const summary = summarizeUsage(
      usage([member("me", { limit: null, remaining: null, fraction: null })], {
        limit: null,
        remaining: null,
        fraction: null,
      }),
    );
    expect(summary.state).toBe("unlimited");
    expect(summary.binding).toBeNull();
  });

  test("an exhausted workspace binds before an exhausted member", () => {
    const summary = summarizeUsage(
      usage([member("me", { status: "exhausted", fraction: 1, remaining: 0 })], {
        status: "exhausted",
        fraction: 1,
        remaining: 0,
      }),
    );
    expect(summary.state).toBe("exhausted");
    expect(summary.binding?.scope).toBe("workspace");
  });

  test("the ceiling with less room left binds; warnings outrank comfortable ceilings", () => {
    const ok = summarizeUsage(
      usage([member("me", { remaining: 90_000_000 })], { remaining: 20_000_000 }),
    );
    expect(ok.state).toBe("ok");
    expect(ok.binding?.scope).toBe("workspace");
    const warning = summarizeUsage(
      usage([member("me", { status: "warning", fraction: 0.85, remaining: 15_000_000 })], {
        remaining: 5_000_000,
      }),
    );
    expect(warning.state).toBe("warning");
    expect(warning.binding?.scope).toBe("member");
  });

  test("selects one subject from a roster", () => {
    const summary = summarizeUsage(
      usage([member("a"), member("b", { status: "warning", fraction: 0.9 })]),
      "b",
    );
    expect(summary.member?.status).toBe("warning");
  });

  test("percent labels never show 0 for some use or 100 before the limit", () => {
    expect(usagePercentLabel(0)).toBe("0");
    expect(usagePercentLabel(0.004)).toBe("<1");
    expect(usagePercentLabel(0.996)).toBe("99");
    expect(usagePercentLabel(1.04)).toBe("104");
  });
});

describe("UsageMeter", () => {
  test("shows shares only by default and amounts only on request", async () => {
    const data = usage([member("me", { used: 62_000_000, fraction: 0.62, remaining: 38_000_000 })]);
    const plain = await renderComponent(<UsageMeter usage={data} />);
    const meter = plain.container.querySelector('[role="meter"]');
    expect(meter?.textContent).toContain("38% left");
    expect(meter?.getAttribute("aria-valuenow")).toBe("62");
    expect(plain.container.textContent).not.toContain("$");
    await plain.unmount();

    const money = await renderComponent(
      <UsageMeter
        usage={data}
        density="hero"
        formatAmount={(micros) => `$${(micros / 1e6).toFixed(2)}`}
      />,
    );
    expect(money.container.textContent).toContain("$38.00 left");
    expect(money.container.textContent).toContain("$62.00 of $100.00 used");
    await money.unmount();
  });

  test("names the workspace pool when it is the tighter ceiling", async () => {
    const r = await renderComponent(
      <UsageMeter
        usage={usage([member("me")], { status: "warning", fraction: 0.9, remaining: 60_000_000 })}
        labels={{ workspaceLine: (value) => `Team: ${value}` }}
      />,
    );
    expect(r.container.textContent).toContain("Team: 10% left");
    await r.unmount();
  });

  test("reads /usage/me through getMyUsage or requestJson", async () => {
    const data = usage([member("me")]);
    const viaMethod: unknown[] = [];
    const a = await renderComponent(
      <UsageMeter
        workspaceId="ws"
        client={{
          getMyUsage: async (...args: unknown[]) => {
            viaMethod.push(args);
            return data;
          },
        }}
      />,
    );
    await flush();
    expect((viaMethod[0] as unknown[])[0]).toBe("ws");
    expect(a.container.textContent).toContain("90% left");
    await a.unmount();

    const paths: string[] = [];
    const b = await renderComponent(
      <UsageMeter
        workspaceId="ws"
        period="2026-09"
        client={
          {
            requestJson: async (
              _method: string,
              path: string,
              _body?: unknown,
              query?: unknown,
            ) => {
              paths.push(`${path}?${new URLSearchParams(query as Record<string, string>)}`);
              return data;
            },
          } as never
        }
      />,
    );
    await flush();
    expect(paths).toEqual(["/v1/workspaces/ws/usage/me?period=2026-09"]);
    await b.unmount();
  });

  test("an unlimited member reads as such", async () => {
    const r = await renderComponent(
      <UsageMeter
        usage={usage([member("me", { limit: null, fraction: null, remaining: null })], {
          limit: null,
          fraction: null,
          remaining: null,
        })}
      />,
    );
    expect(r.container.textContent).toContain("No usage limit");
    await r.unmount();
  });
});

describe("UsageLimitNotice", () => {
  test("is silent while usage is comfortable", async () => {
    const r = await renderComponent(<UsageLimitNotice usage={usage([member("me")])} />);
    expect(r.container.textContent).toBe("");
    await r.unmount();
  });

  test("warns calmly, can be dismissed for the tab, and says when it resets", async () => {
    sessionStorage.clear();
    const data = usage([member("me", { status: "warning", fraction: 0.85, remaining: 15 })]);
    const r = await renderComponent(<UsageLimitNotice usage={data} dismissStorageKey="ws-1" />);
    expect(r.container.textContent).toContain("You've used 85% of your usage limit.");
    expect(r.container.textContent).toMatch(/Resets /);
    const dismiss = r.container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(r.container.textContent).toBe("");
    await r.unmount();
    const again = await renderComponent(<UsageLimitNotice usage={data} dismissStorageKey="ws-1" />);
    expect(again.container.textContent).toBe("");
    await again.unmount();
  });

  test("at the limit it says who can fix it, with host words and action, and can't be dismissed", async () => {
    const r = await renderComponent(
      <UsageLimitNotice
        usage={usage([member("me")], { status: "exhausted", fraction: 1, remaining: 0 })}
        labels={{ workspaceRemedy: "Upgrade your plan to keep going." }}
        action={(summary) => <button type="button">Upgrade ({summary.binding?.scope})</button>}
      />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("This workspace has reached its usage limit.");
    expect(text).toContain("Upgrade your plan to keep going.");
    expect(text).toContain("Upgrade (workspace)");
    expect(r.container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
    await r.unmount();
  });
});

describe("UsageMemberList", () => {
  const roster = usage([
    member("ada", { limit: 100_000_000, used: 85_000_000, fraction: 0.85, status: "warning" }),
    member("grace", { rule: { share: 0.5 }, version: 3, limit: 300_000_000 }),
    member("linus"),
  ]);

  test("shows oversubscription as allowed, never as an error", async () => {
    const r = await renderComponent(
      <UsageMemberList
        usage={roster}
        memberDefault="equal_share"
        describe={(row) => ({ name: row.subjectId.toUpperCase() })}
      />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("Member limits add up to 83% of the budget.");
    expect(text).toContain("ADA");
    expect(text).toContain("Near limit");
    // Read-only without onChangeRule.
    expect(r.container.querySelector("button")).toBeNull();
    await r.unmount();

    const over = await renderComponent(
      <UsageMemberList
        usage={usage([
          member("a", { rule: { share: 0.8 }, limit: 480_000_000 }),
          member("b", { rule: { share: 0.6 }, limit: 360_000_000 }),
        ])}
      />,
    );
    expect(over.container.textContent).toContain("Member limits add up to 140% of the budget.");
    expect(over.container.textContent).toContain("That's allowed");
    expect(
      over.container.querySelector('[data-og-usage-allocation="oversubscribed"]'),
    ).not.toBeNull();
    await over.unmount();
  });

  test("the slider saves a share rule; Default restores the workspace default", async () => {
    const saved: { subject: string; rule: unknown }[] = [];
    const r = await renderComponent(
      <UsageMemberList
        usage={roster}
        memberDefault="equal_share"
        onChangeRule={async (row, rule) => {
          saved.push({ subject: row.subjectId, rule });
        }}
      />,
    );
    const open = (name: string) =>
      [...r.container.querySelectorAll("button")].find((button) =>
        button.getAttribute("aria-label")?.startsWith(`Change limit for ${name}`),
      ) as HTMLButtonElement;
    await act(async () => open("ada").click());
    const save = () =>
      [...r.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      ) as HTMLButtonElement;
    // Opening the editor changes nothing yet.
    expect(save().disabled).toBe(true);
    const thumb = r.container.querySelector('[role="slider"]') as HTMLElement;
    expect(thumb.getAttribute("aria-label")).toBe("Share of the workspace budget");
    for (let step = 0; step < 13; step += 1) {
      await act(async () => {
        thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
    }
    expect(thumb.getAttribute("aria-valuenow")).toBe("30");
    // Three members: an equal share is a third, so 30% is just under one.
    expect(r.container.textContent).toContain("0.9× an equal share");
    await act(async () => save().click());
    await flush();
    expect(saved).toEqual([{ subject: "ada", rule: { share: 0.3 } }]);

    await act(async () => open("grace").click());
    const defaultOption = r.container.querySelector('input[value="default"]') as HTMLInputElement;
    await act(async () => defaultOption.click());
    await act(async () => save().click());
    await flush();
    expect(saved.at(-1)).toEqual({ subject: "grace", rule: null });
    await r.unmount();
  });
});

describe("useUsage", () => {
  test("re-reads when refreshKey changes and keeps the previous reading meanwhile", async () => {
    let calls = 0;
    const client = {
      getMyUsage: async () => {
        calls += 1;
        return usage([member("me", { used: calls * 1_000_000 })]);
      },
    };
    const hook = await renderHook<ReturnType<typeof useUsage>, number>(
      (key) => useUsage({ client, workspaceId: "ws", refreshKey: key }),
      1,
    );
    await flush();
    expect(calls).toBe(1);
    expect(hook.result.current.summary?.member?.used).toBe(1_000_000);
    await hook.rerender(2);
    await flush();
    expect(calls).toBe(2);
    expect(hook.result.current.summary?.member?.used).toBe(2_000_000);
    await hook.unmount();
  });
});
