import { describe, expect, test } from "bun:test";
import type {
  CodexAccount,
  ModelAccountChoiceOption,
  SessionModelAccountChoiceResponse,
} from "@opengeni/sdk";
import { subscriptionAccountMenuContent } from "./subscription-account";
import {
  codexAccountState,
  codexUsage,
  sharedAccountState,
} from "./subscription-account-indicator";

// The two data sources (Codex's session endpoint and the shared subscription
// core) must normalize the same facts into the same menu.
const RESET_5H = "2026-10-22T21:00:00.000Z";
const RESET_WEEK = "2026-10-26T12:00:00.000Z";
const OBSERVED = "2026-10-22T16:50:00.000Z";

const facts = [
  { id: "a", label: "Team 1", email: "a@example.test", used: [36, 62] },
  { id: "b", label: "Team 2", email: "b@example.test", used: [74, 21] },
] as const;

function codexAccount(fact: (typeof facts)[number]): CodexAccount {
  return {
    id: fact.id,
    source: "organization",
    label: fact.label,
    email: fact.email,
    plan: "Pro",
    status: "active",
    fiveHour: { percent: fact.used[0], remaining: 100 - fact.used[0], resetAt: RESET_5H },
    weekly: { percent: fact.used[1], remaining: 100 - fact.used[1], resetAt: RESET_WEEK },
    usageCheckedAt: OBSERVED,
  } as CodexAccount;
}

function claudeOption(fact: (typeof facts)[number]): ModelAccountChoiceOption {
  return {
    provider: "claude",
    connectionId: fact.id,
    label: fact.label,
    accountEmail: fact.email,
    planType: "Pro",
    source: "organization",
    personal: false,
    status: "active",
    refusal: null,
    choosable: true,
    usage: {
      observedAt: OBSERVED,
      windows: [
        { id: "five_hour", usedPercent: fact.used[0], resetsAt: RESET_5H, status: "ok" },
        { id: "seven_day", usedPercent: fact.used[1], resetsAt: RESET_WEEK, status: "ok" },
      ],
      exhaustedUntil: null,
      exhaustedKind: null,
    },
  } as ModelAccountChoiceOption;
}

const idle = { checking: false, checked: false, failed: false };

function codex(extra: Partial<Parameters<typeof codexAccountState>[0]> = {}) {
  return codexAccountState(
    {
      accounts: facts.map(codexAccount),
      pinnedAccountId: null,
      currentSelection: { credentialId: "a", waiting: false },
      currentAccount: codexAccount(facts[0]),
      switchAppliedTo: null,
      loading: false,
      error: null,
      liveUsage: {},
      liveUsageUpdatedAt: null,
      pinning: false,
      pinningTarget: null,
      mutationError: null,
      ...extra,
    },
    idle,
  );
}

function claude(choice: Partial<SessionModelAccountChoiceResponse> = {}) {
  return sharedAccountState(
    "claude",
    {
      loading: false,
      choosing: false,
      choosingTarget: undefined,
      appliedTo: null,
      mutationError: null,
      choice: {
        serving: {
          turnId: "turn-1",
          provider: "claude",
          connectionId: "a",
          modelId: "m",
          preferredModelId: "m",
          reasoningEffort: "high",
          latencyMode: "standard",
        },
        binding: { provider: "claude", connectionId: null, choice: "automatic" },
        bindings: [{ provider: "claude", connectionId: null, choice: "automatic" }],
        accounts: facts.map(claudeOption),
        personal: { connectionsAllowed: false, fallbackAllowed: false, fallbackOptIn: false },
        ...choice,
      },
    },
    "turn-1",
  );
}

const neutral = (value: unknown) => JSON.stringify(value).replaceAll(/Claude|Codex/g, "X");

describe("Codex and Claude sources", () => {
  test("the same accounts and usage produce the same menu", () => {
    const fromCodex = subscriptionAccountMenuContent(codex());
    const fromClaude = subscriptionAccountMenuContent(claude());
    expect(neutral(fromCodex)).toBe(neutral(fromClaude));
    expect(fromCodex.selectionLabel).toBe("Current account");
    expect(fromCodex.usage.windows?.map((window) => [window.label, window.usedPercent])).toEqual([
      ["5h", 36],
      ["Week", 62],
    ]);
    expect(fromCodex.accounts[1]?.usageSummary).toBe("5h 74% · Week 21% used");
  });

  test("an explicit choice reads the same from both sources", () => {
    const fromCodex = subscriptionAccountMenuContent(
      codex({ pinnedAccountId: "b", currentSelection: null, currentAccount: null }),
    );
    const fromClaude = subscriptionAccountMenuContent(
      claude({
        serving: null,
        binding: { provider: "claude", connectionId: "b", choice: "explicit" },
        bindings: [{ provider: "claude", connectionId: "b", choice: "explicit" }],
      }),
    );
    expect(neutral(fromCodex)).toBe(neutral(fromClaude));
    expect(fromCodex.selectionLabel).toBe("Chosen account");
    expect(fromCodex.selectedId).toBe("b");
  });

  test("a failed read is unavailable from both sources", () => {
    const fromCodex = subscriptionAccountMenuContent(
      codex({
        error: new Error("down"),
        accounts: [],
        currentSelection: null,
        currentAccount: null,
      }),
    );
    const fromClaude = subscriptionAccountMenuContent(
      sharedAccountState(
        "claude",
        {
          loading: false,
          choosing: false,
          choosingTarget: undefined,
          appliedTo: null,
          mutationError: null,
          choice: null,
        },
        undefined,
      ),
    );
    expect(neutral(fromCodex)).toBe(neutral(fromClaude));
    expect(fromCodex.displayName).toBe("Accounts unavailable");
    expect(fromCodex.automaticSelected).toBe(false);
  });
});

describe("Codex usage", () => {
  const base = codexAccount(facts[0]);

  test("percent is the used share; remaining is the fallback", () => {
    expect(codexUsage(base, undefined)?.windows.map((window) => window.usedPercent)).toEqual([
      36, 62,
    ]);
    const remainingOnly = codexUsage(
      { ...base, fiveHour: { remaining: 30 }, weekly: null } as CodexAccount,
      undefined,
    );
    expect(remainingOnly?.windows).toEqual([
      { id: "five_hour", usedPercent: 70, resetsAt: null, status: "ok" },
    ]);
  });

  test("windows at 90% are near their limit and at 100% exhausted", () => {
    const usage = codexUsage(
      {
        ...base,
        fiveHour: { percent: 92, remaining: 8 },
        weekly: { percent: 100, remaining: 0 },
      } as CodexAccount,
      undefined,
    );
    expect(usage?.windows.map((window) => window.status)).toEqual(["warning", "exhausted"]);
  });

  test("a cooling-down account says until when", () => {
    const usage = codexUsage(
      { ...base, fiveHour: null, weekly: null, exhaustedUntil: RESET_5H } as CodexAccount,
      undefined,
      Date.parse(RESET_5H) - 1,
    );
    expect(usage).toMatchObject({ windows: [], exhaustedUntil: RESET_5H, exhaustedKind: "quota" });
    expect(codexUsage({ ...base, fiveHour: null, weekly: null } as CodexAccount, undefined)).toBe(
      null,
    );
    // An ended cooldown is not a limit.
    expect(
      codexUsage(
        { ...base, fiveHour: null, weekly: null, exhaustedUntil: RESET_5H } as CodexAccount,
        undefined,
        Date.parse(RESET_5H) + 1,
      ),
    ).toBe(null);
  });

  test("an account with no label, email or plan is named by its ChatGPT id", () => {
    const bare = {
      id: "z",
      chatgptAccountId: "acct-123",
      status: "active",
    } as CodexAccount;
    const state = codex({ accounts: [bare], currentSelection: null, currentAccount: null });
    expect(subscriptionAccountMenuContent(state).accounts[0]?.label).toBe("acct-123");
    const named = codex({
      accounts: [{ ...bare, email: "z@example.test" }],
      currentSelection: null,
      currentAccount: null,
    });
    expect(subscriptionAccountMenuContent(named).accounts[0]?.label).toBe("z@example.test");
  });
});
