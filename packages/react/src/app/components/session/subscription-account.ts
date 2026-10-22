// One provider-neutral shape for a chat's subscription account (Codex, Claude,
// SuperGrok) and its projection onto the account menu. Data sources normalize
// into `SubscriptionAccountState`; everything a person sees is decided here,
// so every provider shows the same structure and copy. Only names, marks and
// plan labels differ.
import type { ClientModel, ModelAccountChoiceRefusal } from "@opengeni/sdk";
import { isCodexProductModel } from "../../lib/session-model";
import type { BillingClass } from "../billing-class-mark";
import type {
  SubscriptionAccountMenuRow,
  SubscriptionAccountMenuUsage,
  SubscriptionAccountUsageWindow,
} from "./subscription-account-menu";

export type SubscriptionAccountUsage = {
  /** When the reading was taken; null when unknown. */
  observedAt: string | null;
  windows: Array<{
    id: string;
    /** Null means unknown; values over 100 can represent overage. */
    usedPercent: number | null;
    resetsAt: string | null;
    status: "ok" | "warning" | "exhausted" | "unknown";
  }>;
  exhaustedUntil: string | null;
  exhaustedKind: "quota" | "rate_limit" | null;
};

export type SubscriptionAccount = {
  id: string;
  label: string | null;
  email: string | null;
  plan: string | null;
  /** Who the account belongs to; null when the source does not say. */
  source: "personal" | "workspace" | "organization" | null;
  /** The provider's account status (`active`, `needs_relogin`, …). */
  status: string;
  refusal: ModelAccountChoiceRefusal | null;
  choosable: boolean;
  /** Undefined: not reported. Null: no reading yet. */
  usage: SubscriptionAccountUsage | null | undefined;
};

export type SubscriptionAccountState = {
  /** `codex`, `claude`, `xai`, … */
  provider: string;
  /** True until the first read settles. */
  loading: boolean;
  /** The accounts could not be read. */
  unavailable: boolean;
  /** Accounts this person can pick for the next turn. */
  accounts: SubscriptionAccount[];
  /** The account the chat runs on (or will next), when this person can see it. */
  current: SubscriptionAccount | null;
  /** The chat runs on a chosen or serving account this person cannot see. */
  currentHidden: boolean;
  /** `current`/`currentHidden` is the account serving the chat's latest turn. */
  serving: boolean;
  /** Automatic selection, not a person's explicit choice. */
  automatic: boolean;
  /** The explicitly chosen account, when this person can see it. */
  chosenId: string | null;
  /** A turn waits for capacity on the current account. */
  waiting: boolean;
  /**
   * A live usage check, for sources that offer one: `checking` until its
   * first reading arrives, `failed` when it produced none for this account.
   */
  usageCheck: "idle" | "checking" | "failed";
  choosing: boolean;
  /** The in-flight target (`null` is automatic; `undefined` when idle). */
  choosingTarget: string | null | undefined;
  appliedTo: "waiting_turn" | "next_turn" | null;
  mutationError: string | null;
};

const PROVIDER: Record<string, { name: string; billingClass: BillingClass }> = {
  codex: { name: "Codex", billingClass: "codex_subscription" },
  claude: { name: "Claude", billingClass: "claude_subscription" },
  xai: { name: "SuperGrok", billingClass: "supergrok_subscription" },
};

export function subscriptionProviderPresentation(provider: string): {
  name: string;
  billingClass: BillingClass;
} {
  return PROVIDER[provider] ?? { name: "Subscription", billingClass: "external" };
}

// Presentation labels only. Preserve every supplied window; never combine
// family-specific, overage or partial windows into an account capacity score.
const WINDOW_LABEL: Record<string, string> = {
  // Neutral ids: they do not say how long the window is.
  primary: "Primary",
  secondary: "Secondary",
  five_hour: "5h",
  seven_day: "Week",
  seven_day_opus: "Week · Opus",
  seven_day_sonnet: "Week · Sonnet",
  overage: "Overage",
  billing: "Billing",
};

const REFUSAL_COPY: Record<ModelAccountChoiceRefusal, string> = {
  inactive: "Unavailable",
  personal_not_allowed: "Turned off here",
  personal_not_owner_work: "Not available for this chat",
  session_has_no_owner: "Needs an owner",
};

const STATUS_COPY: Record<string, string> = {
  needs_relogin: "Needs reconnect",
  error: "Error",
  disabled: "Disabled",
  revoked: "Revoked",
  expired: "Expired",
  suspended: "Suspended",
  paused: "Paused",
  inactive: "Inactive",
  limit_reached: "Limit reached",
};

function time(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function accountLabel(account: SubscriptionAccount): string {
  return account.label ?? account.email ?? account.plan ?? "Account";
}

export function accountStatus(account: SubscriptionAccount): string | null {
  // Inactive is a broad refusal; retain the actual status when it explains why.
  if (account.refusal && account.refusal !== "inactive") return REFUSAL_COPY[account.refusal];
  if (account.status !== "active") return STATUS_COPY[account.status] ?? account.status;
  return account.refusal ? REFUSAL_COPY[account.refusal] : null;
}

function accountSource(account: SubscriptionAccount): string | null {
  return account.source === "personal"
    ? "Your account"
    : account.source === "workspace"
      ? "This workspace"
      : account.source === "organization"
        ? "Organization"
        : null;
}

function windowLabel(id: string): string {
  return WINDOW_LABEL[id] ?? id;
}

/** The reading as usage rows: percentage used, with when each window resets. */
export function subscriptionAccountUsage(
  usage: SubscriptionAccountUsage | null | undefined,
  now = Date.now(),
): {
  windows?: SubscriptionAccountUsageWindow[];
  message?: string;
  note?: string;
  summary?: string;
} {
  if (!usage) return { message: "No usage reading yet" };
  const observed = time(usage.observedAt);
  const windows = usage.windows.map((window) => {
    const reset = time(window.resetsAt);
    const past = reset !== null && Date.parse(window.resetsAt!) <= now;
    return {
      label: windowLabel(window.id),
      usedPercent: window.usedPercent,
      detail: [
        window.status === "unknown"
          ? "Status unknown"
          : window.status === "warning"
            ? "Near its limit"
            : window.status === "exhausted"
              ? "Limit reached"
              : null,
        past ? "Reset passed; usage may be outdated" : reset ? `Resets ${reset}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  const exhaustedTime = time(usage.exhaustedUntil);
  // A limit whose end has passed no longer applies.
  const exhausted =
    usage.exhaustedKind !== null &&
    !(usage.exhaustedUntil && Date.parse(usage.exhaustedUntil) <= now);
  return {
    windows,
    ...(windows.length === 0
      ? {
          message: exhausted
            ? `Limit reached${exhaustedTime ? ` until ${exhaustedTime}` : ""}`
            : "No usage reading yet",
        }
      : {}),
    ...(observed ? { note: `Updated ${observed}` } : {}),
    ...(windows.length > 0
      ? {
          summary: `${windows
            .map(
              (window) =>
                `${window.label} ${window.usedPercent === null ? "unknown" : `${Math.round(window.usedPercent)}%`}`,
            )
            .join(" · ")} used`,
        }
      : {}),
  };
}

function nearLimit(usage: SubscriptionAccountUsage | null | undefined): boolean {
  return (usage?.windows ?? []).some(
    (window) =>
      window.status === "warning" ||
      window.status === "exhausted" ||
      (window.usedPercent !== null && window.usedPercent >= 90),
  );
}

/**
 * Whether there is anything to show or choose. A chat whose provider offers
 * no accounts to this person, with nothing chosen, serving or waiting, shows
 * the provider's mark alone instead of an empty menu.
 */
export function showsSubscriptionAccountMenu(state: SubscriptionAccountState): boolean {
  return (
    state.unavailable ||
    state.accounts.length > 0 ||
    state.current !== null ||
    state.currentHidden ||
    state.waiting ||
    !state.automatic
  );
}

/**
 * The subscription whose accounts a chat's header offers, or null for a chat
 * that does not run on a subscription. Codex product models are Codex
 * subscriptions even before the catalog lists them.
 */
export function subscriptionAccountProvider(
  modelId: string,
  credentialSource: ClientModel["credentialSource"],
): string | null {
  if (isCodexProductModel(modelId)) return "codex";
  return credentialSource?.kind === "connected_subscription" ? credentialSource.provider : null;
}

/** Everything the account menu shows, from the neutral state. */
export function subscriptionAccountMenuContent(state: SubscriptionAccountState) {
  const { name } = subscriptionProviderPresentation(state.provider);
  const current = state.current;
  // A failed read does not know the selection; never claim Automatic for it.
  const unknown = state.unavailable && !current && !state.currentHidden;
  const displayName = current
    ? accountLabel(current)
    : state.currentHidden
      ? "Account unavailable"
      : unknown
        ? "Accounts unavailable"
        : "Automatic";
  const status = current ? accountStatus(current) : null;
  const selectionLabel = state.waiting
    ? "Limit reached"
    : state.serving && (current || state.currentHidden)
      ? "Current account"
      : !state.automatic && !unknown && (!current || current.id === state.chosenId)
        ? "Chosen account"
        : current
          ? "Current account"
          : "Account selection";
  const usageNearLimit = nearLimit(current?.usage);
  const tone: "ok" | "warn" | "bad" =
    current?.status === "needs_relogin" || current?.status === "error"
      ? "bad"
      : status || state.waiting || usageNearLimit
        ? "warn"
        : "ok";
  const usage: SubscriptionAccountMenuUsage = !current
    ? {
        message: state.currentHidden
          ? "Account usage hidden"
          : unknown
            ? "Usage unavailable"
            : "Choose an account to see usage",
      }
    : state.usageCheck === "checking"
      ? { checking: true }
      : state.usageCheck === "failed"
        ? { unavailable: true }
        : subscriptionAccountUsage(current.usage);
  const accounts: SubscriptionAccountMenuRow[] = state.accounts.map((account) => ({
    id: account.id,
    label: accountLabel(account),
    plan: account.plan,
    status: accountStatus(account),
    detail: [
      accountLabel(account),
      account.email,
      account.plan,
      accountSource(account),
      accountStatus(account),
    ]
      .filter(Boolean)
      .join(" · "),
    personal: account.source === "personal",
    disabled: !account.choosable,
    // The current account's usage is already shown above the list.
    usageSummary:
      account.id === current?.id || state.usageCheck === "checking"
        ? undefined
        : subscriptionAccountUsage(account.usage).summary,
  }));
  return {
    ariaLabel: [
      `${name} account`,
      displayName,
      state.waiting ? "Limit reached" : (status ?? (usageNearLimit ? "Near its limit" : null)),
    ]
      .filter(Boolean)
      .join(" · "),
    selectionLabel,
    displayName,
    identity: current?.email && current.email !== displayName ? current.email : null,
    metadata: current
      ? [current.plan, accountSource(current), status].filter(Boolean).join(" · ") ||
        `${name} subscription`
      : `${name} subscription`,
    tone,
    usage,
    accounts,
    selectedId: state.automatic || unknown ? null : state.chosenId,
    automaticSelected: state.automatic && !unknown,
    actionLabel: state.waiting ? "Retry with" : "Use for next turn",
    automaticLabel: "Automatic",
    emptyMessage: state.unavailable ? "Accounts unavailable." : "No accounts available.",
    error: state.mutationError ? `Couldn't switch: ${state.mutationError}` : null,
    note:
      state.appliedTo === "waiting_turn"
        ? "Selection saved. Capacity is being rechecked."
        : state.appliedTo === "next_turn"
          ? "Selection saved for the next turn."
          : state.waiting
            ? "Changing accounts retries the waiting turn."
            : "Applies next turn. The current turn keeps its account.",
  };
}
