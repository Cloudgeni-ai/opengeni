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
    // The provider name and the brand its plans are sold under.
    const neutral = (value: unknown) =>
      JSON.stringify(value).replaceAll(/Claude|Codex|ChatGPT/g, "X");
    expect(neutral(codex)).toBe(neutral(claude));
    expect(claude.ariaLabel).toBe("Claude account · Acme a");
    expect(codex.ariaLabel).toBe("Codex account · Acme a");
  });

  test("the current account shows its plan, owner, email and usage the same way", () => {
    const content = subscriptionAccountMenuContent(state());
    expect(content.selectionLabel).toBe("Current account");
    expect(content.identity).toBe("a@example.test");
    expect(content.metadata).toBe("Claude Pro · Organization");
    expect(content.usage.windows?.map((window) => [window.label, window.leftPercent])).toEqual([
      ["5h", 64],
      ["Week", 38],
    ]);
    expect(content.usage.note).toStartWith("Updated ");
    expect(content.automaticLabel).toBe("Automatic");
    expect(content.actionLabel).toBe("Use for next turn");
    // Other accounts list every window; the current one is shown above.
    expect(
      content.accounts.map((row) => row.windows?.map((window) => window.label) ?? null),
    ).toEqual([null, ["5h", "Week"], []]);
    expect(content.accounts[2]).toMatchObject({ status: "Needs reconnect", disabled: true });
    expect(content.accounts[1]?.detail).toBe(
      "Acme b · b@example.test · Claude Pro · This workspace",
    );
    // Every account has the same plan, so it is shown once, not on each row.
    expect(content.plan).toBe("Claude Pro");
    expect(content.accounts.map((row) => row.plan)).toEqual([null, null, null]);
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
    expect(
      failed.accounts.map((row) => row.windows?.map((window) => window.leftPercent) ?? null),
    ).toEqual([null, [64, 38], []]);
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
    expect(checking.accounts.every((row) => row.windows === null)).toBe(true);
    expect(subscriptionAccountMenuContent(state({ usageCheck: "failed" })).usage).toEqual({
      unavailable: true,
    });
  });
});

describe("usage readings", () => {
  test("a limit whose end has passed no longer reads as reached", () => {
    const ended = snapshot([], {
      exhaustedUntil: "2026-10-22T10:00:00Z",
      exhaustedKind: "quota",
    });
    expect(
      subscriptionAccountUsage("claude", ended, Date.parse("2026-10-22T11:00:00Z")).message,
    ).toBe("No usage reading yet");
    expect(
      subscriptionAccountUsage("claude", ended, Date.parse("2026-10-22T09:00:00Z")).message,
    ).toStartWith("Limit reached until ");
  });

  test("missing readings and empty snapshots say there is no reading yet", () => {
    expect(subscriptionAccountUsage("claude", undefined).message).toBe("No usage reading yet");
    expect(subscriptionAccountUsage("claude", null).message).toBe("No usage reading yet");
    const empty = subscriptionAccountUsage("claude", snapshot([]));
    expect(empty).toMatchObject({ message: "No usage reading yet", windows: [] });
    expect(empty.note).toBeNull();
  });

  test("an account-wide refusal still says until when beside a full Fable week", () => {
    const now = Date.parse("2026-10-22T09:00:00Z");
    const reading = snapshot(
      [
        { id: "seven_day", usedPercent: 40, resetsAt: null, status: "ok" },
        { id: "seven_day_fable", usedPercent: 100, resetsAt: null, status: "ok" },
      ],
      { exhaustedUntil: "2026-10-22T10:00:00Z", exhaustedKind: "quota" },
    );
    expect(subscriptionAccountUsage("claude", reading, now).message).toStartWith(
      "Limit reached until ",
    );
  });

  test("partial and unknown windows are never completed, aggregated or given a made-up percent", () => {
    const view = subscriptionAccountUsage(
      "claude",
      snapshot([
        { id: "seven_day_opus", usedPercent: null, resetsAt: null, status: "unknown" },
        { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
        { id: "custom", usedPercent: 8, resetsAt: null, status: "warning" },
      ]),
    );
    expect(view.windows.map((window) => [window.label, window.leftPercent])).toEqual([
      ["Opus week", null],
      ["Custom", 92],
      ["Extra usage", 0],
    ]);
    // The provider's own warning counts even with plenty left.
    expect(view.windows[1]?.nearLimit).toBe(true);
    // Extra usage never makes the account look limited.
    expect(view.limit).toMatchObject({ reached: false, near: true });
  });

  test("neutral primary/secondary ids do not claim a window length outside Codex", () => {
    const value = snapshot([{ id: "primary", usedPercent: 10, resetsAt: null, status: "ok" }]);
    expect(subscriptionAccountUsage("claude", value).windows[0]?.label).toBe("Primary");
    expect(subscriptionAccountUsage("xai", value).windows[0]?.label).toBe("Primary");
    // The shared core stores Codex's 5-hour reading as `primary`.
    expect(subscriptionAccountUsage("codex", value).windows[0]?.label).toBe("5h");
  });

  test("an account-wide limit without windows names when it ends", () => {
    const view = subscriptionAccountUsage(
      "claude",
      snapshot([], { exhaustedKind: "rate_limit", exhaustedUntil: "2020-01-01T09:00:00Z" }),
      Date.parse("2020-01-01T08:00:00Z"),
    );
    expect(view.message).toStartWith("Limit reached until ");
    expect(view.limit.reached).toBe(true);
    expect(view.windows).toEqual([]);
  });

  test("a past reset no longer claims the limit or a share left", () => {
    const value = snapshot([
      { id: "five_hour", usedPercent: 100, resetsAt: "2026-10-12T12:00:00Z", status: "exhausted" },
    ]);
    const before = subscriptionAccountUsage("claude", value, Date.parse("2026-10-12T11:00:00Z"));
    const after = subscriptionAccountUsage("claude", value, Date.parse("2026-10-12T13:00:00Z"));
    expect(before.windows[0]).toMatchObject({ limitReached: true, leftPercent: 0 });
    expect(before.limit).toMatchObject({
      reached: true,
      until: Date.parse("2026-10-12T12:00:00Z"),
    });
    expect(after.windows[0]).toMatchObject({
      limitReached: false,
      leftPercent: null,
      resetPassed: true,
      resetsAt: null,
    });
    expect(after.limit.reached).toBe(false);
  });

  test("only reported windows: verified Ultra and ChatGPT Pro have no 5-hour window", () => {
    const ultra = subscriptionAccountUsage(
      "claude",
      snapshot([
        { id: "seven_day", usedPercent: 24, resetsAt: null, status: "ok" },
        { id: "seven_day_fable", usedPercent: 61, resetsAt: null, status: "ok" },
        { id: "overage", usedPercent: 0, resetsAt: null, status: "ok" },
      ]),
    );
    expect(ultra.windows.map((window) => window.label)).toEqual([
      "Week",
      "Fable week",
      "Extra usage",
    ]);
    const pro = subscriptionAccountUsage(
      "codex",
      snapshot([{ id: "secondary", usedPercent: 40, resetsAt: null, status: "ok" }]),
    );
    expect(pro.windows.map((window) => [window.label, window.leftPercent])).toEqual([["Week", 60]]);
  });

  test("an Ultra plan never shows a 5h window, but a refusal on it still reads as a limit", () => {
    const now = Date.parse("2026-11-05T14:00:00Z");
    const ultra = account("ultra", {
      plan: "claude_max_20x",
      usage: snapshot([
        {
          id: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-11-05T17:19:00Z",
          status: "exhausted",
        },
        { id: "seven_day", usedPercent: 71, resetsAt: "2026-11-10T00:00:00Z", status: "ok" },
      ]),
    });
    const max = account("max", { plan: "claude_max" });
    const content = subscriptionAccountMenuContent(
      state({ accounts: [ultra, max], current: ultra }),
      now,
    );
    expect(content.usage.windows?.map((window) => window.label)).toEqual(["Week"]);
    expect(content.usage.message).toStartWith("Limit reached until ");
    expect(content.tone).toBe("warn");
    // A bare Max (Max or Ultra) keeps the 5h window its reading reports.
    const rows = subscriptionAccountMenuContent(
      state({ accounts: [ultra, max], current: null }),
      now,
    ).accounts;
    expect(rows.map((row) => row.windows?.map((window) => window.label))).toEqual([
      ["Week"],
      ["5h", "Week"],
    ]);
    expect(rows[0]!.usageMessage).toStartWith("Limit reached until ");
  });
});

describe("plans and marks in the account list", () => {
  const claudeAccounts = [
    account("pro", { plan: "claude_pro", email: "sam.longername.lindqvist@example.test" }),
    account("max", { plan: "claude_max_5x" }),
    account("ultra", { plan: "claude_max_20x" }),
    account("bare", { plan: "claude_max" }),
  ];

  test("plans read as the provider names them, on each row only when they differ", () => {
    const content = subscriptionAccountMenuContent(
      state({ accounts: claudeAccounts, current: null }),
    );
    expect(content.plan).toBeNull();
    expect(content.accounts.map((row) => row.plan)).toEqual([
      "Pro",
      "Max",
      "Ultra",
      "Max or Ultra",
    ]);
    // Never the raw id.
    expect(JSON.stringify(content)).not.toContain("claude_max");
  });

  test("the full email stays in the row, never shortened", () => {
    const content = subscriptionAccountMenuContent(
      state({ accounts: claudeAccounts, current: null }),
    );
    expect(content.accounts[0]).toMatchObject({
      label: "Acme pro",
      email: "sam.longername.lindqvist@example.test",
    });
  });

  test("the chosen account is marked for the next turn and the serving one as in use", () => {
    const content = subscriptionAccountMenuContent(
      state({ automatic: false, chosenId: "b", serving: true }),
    );
    expect(content.accounts.map((row) => row.mark)).toEqual(["in_use", "next_turn", null]);
    const automatic = subscriptionAccountMenuContent(state());
    expect(automatic.automaticSelected).toBe(true);
    expect(automatic.accounts.map((row) => row.mark)).toEqual(["in_use", null, null]);
  });

  test("ChatGPT and SuperGrok plans", () => {
    const codex = subscriptionAccountMenuContent(
      state({
        provider: "codex",
        accounts: [account("p", { plan: "plus" }), account("q", { plan: "team" })],
        current: null,
      }),
    );
    expect(codex.accounts.map((row) => row.plan)).toEqual(["Plus", "Business"]);
    const grok = subscriptionAccountMenuContent(
      state({
        provider: "xai",
        accounts: [account("g", { plan: "SuperGrok Heavy" })],
        current: null,
      }),
    );
    expect(grok.plan).toBe("SuperGrok Heavy");
  });
});

describe("which subscription a chat offers accounts for", () => {
  test("Codex product models, then the catalog's connected subscription", () => {
    expect(subscriptionAccountProvider("codex/gpt-6-astra", undefined)).toBe("codex");
    expect(
      subscriptionAccountProvider("organization-claude-subscription/claude-opus-5-5", {
        id: "organization-claude-subscription/claude-opus-5-5",
        provider: "organization-claude-subscription",
        credentialSource: { kind: "connected_subscription", provider: "claude" },
      }),
    ).toBe("claude");
    expect(
      subscriptionAccountProvider("supergrok/grok-4.6", {
        id: "supergrok/grok-4.6",
        provider: "supergrok",
        credentialSource: { kind: "connected_subscription", provider: "xai" },
      }),
    ).toBe("xai");
    expect(subscriptionAccountProvider("gpt-5.6-sol", undefined)).toBeNull();
  });

  // The workspace catalog never projects `credentialSource`; these are the
  // rows it actually returns for subscription models.
  test("catalog rows without a credential source still name their subscription", () => {
    for (const id of [
      "organization-claude-subscription/claude-opus-5-5",
      "workspace-claude-subscription/claude-sonnet-5-5",
      "claude/claude-haiku-5-5",
    ]) {
      expect(subscriptionAccountProvider(id, undefined)).toBe("claude");
      expect(
        subscriptionAccountProvider(id, { id, provider: id.split("/")[0]!, source: undefined }),
      ).toBe("claude");
    }
    expect(
      subscriptionAccountProvider("supergrok/grok-4.7", {
        id: "supergrok/grok-4.7",
        provider: "supergrok",
        source: "supergrok",
      }),
    ).toBe("xai");
    expect(
      subscriptionAccountProvider("gpt-5.6-sol", {
        id: "gpt-5.6-sol",
        provider: "opengeni",
        source: "opengeni",
      }),
    ).toBeNull();
    expect(
      subscriptionAccountProvider("organization-anthropic/claude-opus-5-5", {
        id: "organization-anthropic/claude-opus-5-5",
        provider: "organization-anthropic",
        source: undefined,
      }),
    ).toBeNull();
  });
});
