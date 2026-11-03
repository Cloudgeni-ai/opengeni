// One provider-neutral shape for a chat's subscription account (Codex, Claude,
// SuperGrok) and its projection onto the account menu. Data sources normalize
// into `SubscriptionAccountState`; everything a person sees is decided here,
// so every provider shows the same structure and copy. Only names, marks and
// plan labels differ.
import type { ClientModel, ModelAccountChoiceRefusal } from "@opengeni/sdk";
import { isClaudeSubscriptionModelId } from "@opengeni/contracts/claude-subscription-model-ids";
import { connectedSubscriptionProvider } from "../../../model-policy";
import { isCodexProductModel } from "../../lib/session-model";
import {
  subscriptionLimit,
  subscriptionPlanLabel,
  subscriptionWindows,
  type SubscriptionLimit,
  type SubscriptionWindow,
} from "../../lib/subscription-accounts";
import type { BillingClass } from "../billing-class-mark";
import type {
  SubscriptionAccountMenuRow,
  SubscriptionAccountMenuUsage,
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

function time(value: string | number | null): string | null {
  if (value === null) return null;
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The name an account goes by: its label, else its email, else its plan. */
export function accountLabel(account: SubscriptionAccount, provider = ""): string {
  return (
    account.label ??
    account.email ??
    subscriptionPlanLabel(provider, account.plan) ??
    account.plan ??
    "Account"
  );
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

/** An account's usage as every surface shows it: its reported windows and its limit. */
export type SubscriptionAccountUsageView = {
  windows: SubscriptionWindow[];
  limit: SubscriptionLimit;
  /** Words instead of windows: no reading, or a limit with no window to show it. */
  message: string | null;
  /** "Updated 3 Nov, 15:29", when the reading says when it was taken. */
  note: string | null;
};

/** The reading as the provider reported it: every window, labelled, never completed. */
export function subscriptionAccountUsage(
  provider: string,
  usage: SubscriptionAccountUsage | null | undefined,
  now = Date.now(),
): SubscriptionAccountUsageView {
  const windows = subscriptionWindows(provider, usage?.windows ?? [], now);
  const limit = subscriptionLimit(windows, usage?.exhaustedUntil ?? null, now);
  const until = time(limit.until);
  const observed = time(usage?.observedAt ?? null);
  return {
    windows,
    limit,
    // A limit that no window shows (a refusal) still says until when.
    message:
      limit.reached && !windows.some((window) => window.limitReached)
        ? `Limit reached${until ? ` until ${until}` : ""}`
        : windows.length === 0
          ? "No usage reading yet"
          : null,
    note: observed ? `Updated ${observed}` : null,
  };
}

/** One plan label when every listed account has the same plan, else null. */
function sharedPlan(provider: string, accounts: readonly SubscriptionAccount[]): string | null {
  const plans = new Set(accounts.map((account) => subscriptionPlanLabel(provider, account.plan)));
  const [only] = plans;
  return plans.size === 1 && only ? only : null;
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
 * subscriptions even before the catalog lists them, and so are Claude
 * subscription model ids. The workspace catalog leaves `credentialSource`
 * out, so its public provider id and rail decide for the rest.
 */
export function subscriptionAccountProvider(
  modelId: string,
  model: Pick<ClientModel, "id" | "provider" | "source" | "credentialSource"> | null | undefined,
): string | null {
  if (isCodexProductModel(modelId)) return "codex";
  if (isClaudeSubscriptionModelId(modelId)) return "claude";
  return model ? connectedSubscriptionProvider(model) : null;
}

/** Everything the account menu shows, from the neutral state. */
export function subscriptionAccountMenuContent(
  state: SubscriptionAccountState,
  now: number = Date.now(),
) {
  const { name } = subscriptionProviderPresentation(state.provider);
  const provider = state.provider;
  const current = state.current;
  // A failed read does not know the selection; never claim Automatic for it.
  const unknown = state.unavailable && !current && !state.currentHidden;
  const displayName = current
    ? accountLabel(current, provider)
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
  const currentUsage = current ? subscriptionAccountUsage(provider, current.usage, now) : null;
  const limitTone = currentUsage?.limit.reached || currentUsage?.limit.near;
  const tone: "ok" | "warn" | "bad" =
    current?.status === "needs_relogin" || current?.status === "error"
      ? "bad"
      : status || state.waiting || limitTone
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
        : {
            windows: currentUsage!.windows,
            ...(currentUsage!.message ? { message: currentUsage!.message } : {}),
            ...(currentUsage!.note ? { note: currentUsage!.note } : {}),
          };
  // The plan is shown once: beside the list when every account has the same
  // plan, else on each row (by its own name, the provider being clear here).
  const plan = sharedPlan(provider, state.accounts);
  const selectedId = state.automatic || unknown ? null : state.chosenId;
  const accounts: SubscriptionAccountMenuRow[] = state.accounts.map((account) => {
    const label = accountLabel(account, provider);
    const rowStatus = accountStatus(account);
    // The current account's usage is shown above the list; a live check
    // hides every reading until it answers.
    const rowUsage =
      account.id === current?.id || state.usageCheck === "checking"
        ? null
        : subscriptionAccountUsage(provider, account.usage, now);
    return {
      id: account.id,
      label,
      email: account.email && account.email !== label ? account.email : null,
      plan: plan ? null : subscriptionPlanLabel(provider, account.plan, { brand: false }),
      status: rowStatus,
      mark:
        account.id === selectedId
          ? "next_turn"
          : account.id === current?.id && !state.currentHidden
            ? "in_use"
            : null,
      windows: rowUsage?.windows ?? null,
      // A row without a reading stays quiet; only a limit no window shows gets words.
      usageMessage: rowUsage?.limit.reached ? rowUsage.message : null,
      detail: [
        label,
        account.email,
        subscriptionPlanLabel(provider, account.plan),
        accountSource(account),
        rowStatus,
      ]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join(" · "),
      personal: account.source === "personal",
      disabled: !account.choosable,
    };
  });
  return {
    ariaLabel: [
      `${name} account`,
      displayName,
      state.waiting
        ? "Limit reached"
        : (status ??
          (currentUsage?.limit.reached
            ? "Limit reached"
            : currentUsage?.limit.near
              ? "Near its limit"
              : null)),
    ]
      .filter(Boolean)
      .join(" · "),
    selectionLabel,
    displayName,
    identity: current?.email && current.email !== displayName ? current.email : null,
    metadata: current
      ? [subscriptionPlanLabel(provider, current.plan), accountSource(current), status]
          .filter(Boolean)
          .join(" · ") || `${name} subscription`
      : `${name} subscription`,
    tone,
    usage,
    accounts,
    plan,
    selectedId,
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
