import { describe, expect, test } from "bun:test";
import {
  showsSubscriptionAccountMenu,
  subscriptionAccountMenuContent,
  subscriptionAccountProvider,
  subscriptionAccountUsage,
  type SubscriptionAccount,
  type SubscriptionAccountState,
  type SubscriptionAccountUsage,
} from "./subscription-account";

const snapshot = (
  windows: SubscriptionAccountUsage["windows"],
  extra: Partial<SubscriptionAccountUsage> = {},
): SubscriptionAccountUsage => ({
  windows,
  observedAt: null,
  exhaustedUntil: null,
  exhaustedKind: null,
  ...extra,
});

function account(id: string, extra: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id,
    label: `Acme ${id}`,
    email: `${id}@example.test`,
    plan: "Pro",
    source: "organization",
    status: "active",
    refusal: null,
    choosable: true,
    usage: snapshot(
      [
        { id: "five_hour", usedPercent: 36, resetsAt: null, status: "ok" },
        { id: "seven_day", usedPercent: 62, resetsAt: null, status: "ok" },
      ],
      { observedAt: "2026-10-22T16:50:00Z" },
    ),
    ...extra,
  };
}

function state(extra: Partial<SubscriptionAccountState> = {}): SubscriptionAccountState {
  const accounts = [
    account("a"),
    account("b", { source: "workspace" }),
    account("c", { status: "needs_relogin", choosable: false, refusal: "inactive", usage: null }),
  ];
  return {
    provider: "claude",
    loading: false,
    unavailable: false,
    accounts,
    current: accounts[0]!,
    currentHidden: false,
    serving: false,
    automatic: true,
    chosenId: null,
    waiting: false,
    usageCheck: "idle",
    choosing: false,
    choosingTarget: undefined,
    appliedTo: null,
    mutationError: null,
    ...extra,
  };
}

describe("one menu for every subscription provider", () => {
  test("Codex and Claude differ only in the provider name", () => {
    const claude = subscriptionAccountMenuContent(state({ provider: "claude" }));
    const codex = subscriptionAccountMenuContent(state({ provider: "codex" }));
    const neutral = (value: unknown) => JSON.stringify(value).replaceAll(/Claude|Codex/g, "X");
    expect(neutral(codex)).toBe(neutral(claude));
    expect(claude.ariaLabel).toBe("Claude account · Acme a");
    expect(codex.ariaLabel).toBe("Codex account · Acme a");
  });

  test("the current account shows its plan, owner, email and usage the same way", () => {
    const content = subscriptionAccountMenuContent(state());
    expect(content.selectionLabel).toBe("Current account");
    expect(content.identity).toBe("a@example.test");
    expect(content.metadata).toBe("Pro · Organization");
    expect(content.usage.windows?.map((window) => [window.label, window.usedPercent])).toEqual([
      ["5h", 36],
      ["Week", 62],
    ]);
    expect(content.usage.note).toStartWith("Updated ");
    expect(content.automaticLabel).toBe("Automatic");
    expect(content.actionLabel).toBe("Use for next turn");
    // Other accounts summarize each window; the current one is shown above.
    expect(content.accounts.map((row) => row.usageSummary)).toEqual([
      undefined,
      "5h 36% · Week 62% used",
      undefined,
    ]);
    expect(content.accounts[2]).toMatchObject({ status: "Needs reconnect", disabled: true });
    expect(content.accounts[1]?.detail).toBe("Acme b · b@example.test · Pro · This workspace");
  });

  test("a turn waiting for capacity offers a retry for any provider", () => {
    for (const provider of ["codex", "claude"]) {
      const content = subscriptionAccountMenuContent(state({ provider, waiting: true }));
      expect(content.selectionLabel).toBe("Limit reached");
      expect(content.actionLabel).toBe("Retry with");
      expect(content.tone).toBe("warn");
      expect(content.note).toBe("Changing accounts retries the waiting turn.");
    }
  });

  test("a chosen account this person cannot see keeps a way back to Automatic", () => {
    const content = subscriptionAccountMenuContent(
      state({ current: null, currentHidden: true, automatic: false, chosenId: null }),
    );
    expect(content.displayName).toBe("Account unavailable");
    expect(content.selectionLabel).toBe("Chosen account");
    expect(content.usage.message).toBe("Account usage hidden");
    expect(content.automaticSelected).toBe(false);
    expect(content.selectedId).toBeNull();
  });

  test("an explicit choice is checked and named as chosen", () => {
    const content = subscriptionAccountMenuContent(state({ automatic: false, chosenId: "a" }));
    expect(content.selectionLabel).toBe("Chosen account");
    expect(content.selectedId).toBe("a");
    expect(content.automaticSelected).toBe(false);
  });

  test("tone flags reconnects and windows near their limit", () => {
    expect(
      subscriptionAccountMenuContent(state({ current: account("x", { status: "needs_relogin" }) }))
        .tone,
    ).toBe("bad");
    expect(
      subscriptionAccountMenuContent(
        state({
          current: account("x", {
            usage: snapshot([{ id: "five_hour", usedPercent: 95, resetsAt: null, status: "ok" }]),
          }),
        }),
      ).tone,
    ).toBe("warn");
    expect(subscriptionAccountMenuContent(state()).tone).toBe("ok");
  });

  test("empty and failed reads say so in the same words", () => {
    const empty = subscriptionAccountMenuContent(state({ accounts: [], current: null }));
    expect(empty.emptyMessage).toBe("No accounts available.");
    expect(empty.displayName).toBe("Automatic");
    expect(empty.metadata).toBe("Claude subscription");
    const failed = subscriptionAccountMenuContent(
      state({ accounts: [], current: null, unavailable: true }),
    );
    expect(failed.emptyMessage).toBe("Accounts unavailable.");
    // A failed read does not know the selection, so nothing claims Automatic.
    expect(failed.displayName).toBe("Accounts unavailable");
    expect(failed.selectionLabel).toBe("Account selection");
    expect(failed.automaticSelected).toBe(false);
    expect(failed.selectedId).toBeNull();
    expect(failed.ariaLabel).toBe("Claude account · Accounts unavailable");
    expect(subscriptionAccountMenuContent(state({ mutationError: "busy" })).error).toBe(
      "Couldn't switch: busy",
    );
  });

  test("a failed check on the current account keeps the other accounts' readings", () => {
    const failed = subscriptionAccountMenuContent(state({ usageCheck: "failed" }));
    expect(failed.accounts.map((row) => row.usageSummary)).toEqual([
      undefined,
      "5h 36% · Week 62% used",
      undefined,
    ]);
  });

  test("the serving account is the current account, even when another one is chosen", () => {
    const hidden = subscriptionAccountMenuContent(
      state({ current: null, currentHidden: true, serving: true, automatic: false, chosenId: "b" }),
    );
    expect(hidden.selectionLabel).toBe("Current account");
    expect(hidden.displayName).toBe("Account unavailable");
    expect(hidden.selectedId).toBe("b");
    const visible = subscriptionAccountMenuContent(
      state({ serving: true, automatic: false, chosenId: "a" }),
    );
    expect(visible.selectionLabel).toBe("Current account");
  });

  test("a chip near its limit says so to assistive technology", () => {
    const near = subscriptionAccountMenuContent(
      state({
        current: account("a", {
          usage: snapshot([
            { id: "five_hour", usedPercent: 95, resetsAt: null, status: "warning" },
          ]),
        }),
      }),
    );
    expect(near.ariaLabel).toBe("Claude account · Acme a · Near its limit");
  });

  test("with nothing to choose or show, only the provider mark remains", () => {
    expect(showsSubscriptionAccountMenu(state({ accounts: [], current: null }))).toBe(false);
    expect(showsSubscriptionAccountMenu(state())).toBe(true);
    for (const extra of [
      { unavailable: true },
      { currentHidden: true },
      { waiting: true },
      { automatic: false },
    ]) {
      expect(showsSubscriptionAccountMenu(state({ accounts: [], current: null, ...extra }))).toBe(
        true,
      );
    }
  });

  test("a live check hides readings until it answers", () => {
    const checking = subscriptionAccountMenuContent(state({ usageCheck: "checking" }));
    expect(checking.usage).toEqual({ checking: true });
    expect(checking.accounts.every((row) => row.usageSummary === undefined)).toBe(true);
    expect(subscriptionAccountMenuContent(state({ usageCheck: "failed" })).usage).toEqual({
      unavailable: true,
    });
  });
});

describe("usage readings", () => {
  test("missing readings and empty snapshots say there is no reading yet", () => {
    expect(subscriptionAccountUsage(undefined).message).toBe("No usage reading yet");
    expect(subscriptionAccountUsage(null).message).toBe("No usage reading yet");
    const empty = subscriptionAccountUsage(snapshot([]));
    expect(empty).toMatchObject({ message: "No usage reading yet", windows: [] });
    expect(empty.note).toBeUndefined();
  });

  test("partial and unknown windows are never completed, aggregated or given a made-up percent", () => {
    const view = subscriptionAccountUsage(
      snapshot([
        { id: "seven_day_opus", usedPercent: null, resetsAt: null, status: "unknown" },
        { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
        { id: "custom", usedPercent: 8, resetsAt: null, status: "warning" },
      ]),
    );
    expect(view.windows?.map((window) => window.usedPercent)).toEqual([null, 125, 8]);
    expect(view.windows?.map((window) => window.label)).toEqual([
      "Week · Opus",
      "Overage",
      "custom",
    ]);
    expect(view.summary).toBe("Week · Opus unknown · Overage 125% · custom 8% used");
    expect(view.windows?.[0]?.detail).toContain("Status unknown");
    expect(view.windows?.[2]?.detail).toContain("Near its limit");
  });

  test("neutral primary/secondary ids do not claim a window length", () => {
    const view = subscriptionAccountUsage(
      snapshot([{ id: "primary", usedPercent: 10, resetsAt: null, status: "ok" }]),
    );
    expect(view.windows?.[0]?.label).toBe("Primary");
  });

  test("an account-wide limit without windows names when it ends", () => {
    const view = subscriptionAccountUsage(
      snapshot([], { exhaustedKind: "rate_limit", exhaustedUntil: "2020-01-01T09:00:00Z" }),
    );
    expect(view.message).toStartWith("Limit reached until ");
    expect(view.windows).toEqual([]);
  });

  test("a past reset keeps the reading but says it may be outdated", () => {
    const value = snapshot([
      { id: "five_hour", usedPercent: 100, resetsAt: "2026-10-12T12:00:00Z", status: "exhausted" },
    ]);
    const before = subscriptionAccountUsage(value, Date.parse("2026-10-12T11:00:00Z"));
    const after = subscriptionAccountUsage(value, Date.parse("2026-10-12T13:00:00Z"));
    expect(before.windows?.[0]?.detail).toContain("Resets ");
    expect(after.windows?.[0]?.detail).toContain("Reset passed; usage may be outdated");
    expect(after.windows?.[0]?.detail).toContain("Limit reached");
    expect(after.windows?.[0]?.usedPercent).toBe(100);
  });
});

describe("which subscription a chat offers accounts for", () => {
  test("Codex product models, then the catalog's connected subscription", () => {
    expect(subscriptionAccountProvider("codex/gpt-6-astra", undefined)).toBe("codex");
    expect(
      subscriptionAccountProvider("organization-claude-subscription/claude-opus-5-5", {
        kind: "connected_subscription",
        provider: "claude",
      }),
    ).toBe("claude");
    expect(
      subscriptionAccountProvider("supergrok/grok-4.6", {
        kind: "connected_subscription",
        provider: "xai",
      }),
    ).toBe("xai");
    expect(subscriptionAccountProvider("gpt-5.6-sol", undefined)).toBeNull();
  });
});
