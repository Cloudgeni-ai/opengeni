// The session-header account control for every subscription provider: the
// provider's mark opens one menu with the account the chat uses, its usage,
// and the accounts that can serve the next turn. The control and its content
// are provider-neutral (`subscription-account.ts`); only where the data comes
// from differs. Codex still reads its session endpoint, which alone reports a
// turn waiting for capacity and offers a live usage check.
import { useState } from "react";
import type {
  CodexAccount,
  CodexUsageMap,
  ModelAccountChoiceOption,
  SessionEvent,
  SessionModelAccountChoiceResponse,
} from "@opengeni/sdk";

import { useCodexAccounts, type UseCodexAccountsResult } from "../../../hooks/use-codex-accounts";
import {
  useSessionModelAccount,
  type UseSessionModelAccountResult,
} from "../../../hooks/use-session-model-account";
import { Skeleton } from "../../../ui/skeleton";
import { BillingClassMark } from "../billing-class-mark";
import {
  showsSubscriptionAccountMenu,
  subscriptionAccountMenuContent,
  subscriptionProviderPresentation,
  type SubscriptionAccount,
  type SubscriptionAccountState,
  type SubscriptionAccountUsage,
} from "./subscription-account";
import { SubscriptionAccountMenu } from "./subscription-account-menu";

type IndicatorProps = {
  workspaceId: string;
  sessionId: string;
  /** The session's organization; scopes personal-account choices. */
  organizationId: string | null;
  /** The session model's subscription provider (`codex`, `claude`, `xai`). */
  provider: string;
  /** The newest started turn, to show the account that served it. */
  servingTurnId?: string | undefined;
  events?: SessionEvent[];
};

export function SubscriptionAccountIndicator(props: IndicatorProps) {
  return props.provider === "codex" ? (
    <CodexAccountSource {...props} />
  ) : (
    <SharedAccountSource {...props} />
  );
}

/** Renders the neutral state; identical for every provider. */
export function SubscriptionAccountControl({
  state,
  onChoose,
  onOpenChange,
}: {
  state: SubscriptionAccountState;
  onChoose: (accountId: string | null) => void;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const { name, billingClass } = subscriptionProviderPresentation(state.provider);
  if (state.loading) {
    return (
      <Skeleton
        role="status"
        className="h-6 w-11 shrink-0 rounded-full"
        aria-label={`Loading ${name} account`}
      />
    );
  }
  // Nothing to choose or show (the provider's accounts are not offered for
  // this chat): the provider's mark alone, as on any other subscription chat.
  if (!showsSubscriptionAccountMenu(state)) {
    return (
      <BillingClassMark
        billingClass={billingClass}
        className="size-3.5 shrink-0 text-fg-muted"
        aria-label=""
      />
    );
  }
  return (
    <SubscriptionAccountMenu
      {...subscriptionAccountMenuContent(state)}
      triggerMark={
        <BillingClassMark
          billingClass={billingClass}
          className="size-3.5 text-current"
          aria-label=""
        />
      }
      headerMark={<BillingClassMark billingClass={billingClass} className="size-4 text-current" />}
      choosing={state.choosing}
      choosingTarget={state.choosingTarget}
      onChoose={onChoose}
      onOpenChange={onOpenChange}
    />
  );
}

// ── Shared subscription core (Claude, SuperGrok, …) ─────────────────────────

export function sharedAccount(option: ModelAccountChoiceOption): SubscriptionAccount {
  return {
    id: option.connectionId,
    label: option.label,
    email: option.accountEmail,
    plan: option.planType,
    source: option.personal ? "personal" : option.source,
    status: option.status,
    refusal: option.refusal,
    choosable: option.choosable,
    usage: option.usage,
  };
}

/** The shared subscription core's session choice as the neutral state. */
export function sharedAccountState(
  provider: string,
  account: Pick<
    UseSessionModelAccountResult,
    "loading" | "choosing" | "choosingTarget" | "appliedTo" | "mutationError"
  > & { choice: SessionModelAccountChoiceResponse | null },
  servingTurnId: string | undefined,
): SubscriptionAccountState {
  const choice = account.choice;
  const options = (choice?.accounts ?? []).filter((each) => each.provider === provider);
  const binding =
    choice?.bindings?.find((each) => each.provider === provider) ??
    (choice?.binding?.provider === provider ? choice.binding : null);
  const explicit = binding?.choice === "explicit";
  const serving =
    choice?.serving &&
    choice.serving.turnId === servingTurnId &&
    choice.serving.provider === provider
      ? choice.serving
      : null;
  const currentId = serving ? serving.connectionId : binding?.connectionId;
  const current = currentId
    ? (options.find((each) => each.connectionId === currentId) ?? null)
    : null;
  return {
    provider,
    loading: account.loading && !choice,
    unavailable: !choice,
    accounts: options.map(sharedAccount),
    current: current ? sharedAccount(current) : null,
    currentHidden: !current && (explicit || serving !== null),
    serving: serving !== null,
    automatic: !explicit,
    chosenId: explicit ? (binding?.connectionId ?? null) : null,
    waiting: false,
    // Only the authorized stored reading; opening the menu never probes a provider.
    usageCheck: "idle",
    choosing: account.choosing,
    choosingTarget: account.choosingTarget,
    appliedTo: account.appliedTo,
    mutationError: account.mutationError?.message ?? null,
  };
}

function SharedAccountSource(props: IndicatorProps) {
  const { provider } = props;
  const account = useSessionModelAccount({
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    provider,
    organizationId: props.organizationId,
    pollIntervalMs: 60_000,
    ...(props.events !== undefined ? { events: props.events } : {}),
  });
  const state = sharedAccountState(provider, account, props.servingTurnId);
  return (
    <SubscriptionAccountControl
      state={state}
      onChoose={(id) => {
        // After a failed read the selection is unknown, so Automatic is sent.
        if (
          !state.unavailable &&
          (id === null ? state.automatic : !state.automatic && state.chosenId === id)
        ) {
          return;
        }
        void account.choose(id);
      }}
    />
  );
}

// ── Codex ───────────────────────────────────────────────────────────────────

const AUTO = "auto";
// Reopening the menu reuses live readings this recent instead of asking the
// provider again; older ones stay on screen while the menu re-checks.
const LIVE_USAGE_REUSE_MS = 30_000;

export function codexUsage(
  account: CodexAccount,
  live: CodexUsageMap[string] | undefined,
  now = Date.now(),
): SubscriptionAccountUsage | null {
  const window = (
    id: string,
    reading: CodexAccount["fiveHour"],
  ): SubscriptionAccountUsage["windows"] => {
    if (!reading) return [];
    const usedPercent =
      typeof reading.percent === "number"
        ? reading.percent
        : typeof reading.remaining === "number"
          ? 100 - reading.remaining
          : null;
    return [
      {
        id,
        usedPercent,
        resetsAt: reading.resetAt ?? null,
        status:
          usedPercent === null
            ? "unknown"
            : usedPercent >= 100
              ? "exhausted"
              : usedPercent >= 90
                ? "warning"
                : "ok",
      },
    ];
  };
  const windows = [
    ...window("five_hour", account.fiveHour),
    ...window("seven_day", account.weekly),
  ];
  // The endpoint reports a cooldown even after it ended; only a future one applies.
  const exhaustedUntil =
    account.exhaustedUntil && Date.parse(account.exhaustedUntil) > now
      ? account.exhaustedUntil
      : null;
  if (windows.length === 0 && !exhaustedUntil) return null;
  return {
    observedAt: live?.usage?.fetchedAt ?? account.usageCheckedAt ?? null,
    windows,
    exhaustedUntil,
    exhaustedKind: exhaustedUntil ? "quota" : null,
  };
}

/** The Codex session endpoint as the neutral state. */
export function codexAccountState(
  codex: Pick<
    UseCodexAccountsResult,
    | "accounts"
    | "pinnedAccountId"
    | "currentSelection"
    | "currentAccount"
    | "switchAppliedTo"
    | "loading"
    | "error"
    | "liveUsage"
    | "liveUsageUpdatedAt"
    | "pinning"
    | "pinningTarget"
    | "mutationError"
  >,
  check: { checking: boolean; checked: boolean; failed: boolean },
): SubscriptionAccountState {
  // Live readings from an earlier check (this menu, another session's, or
  // Settings) stay visible while a new check runs instead of flashing away.
  const awaitingFirstUsage = check.checking && codex.liveUsageUpdatedAt === null;
  const selection = codex.currentSelection;
  const effective =
    (selection ? codex.currentAccount : null) ??
    codex.accounts.find(
      (account) => account.id === (selection ? selection.credentialId : codex.pinnedAccountId),
    ) ??
    null;
  // A live check that returned nothing for an account hides its older reading.
  const liveMissing = (id: string) => {
    const status = codex.liveUsage[id]?.status;
    return check.failed || (check.checked && !status) || status === "error" || status === "no-data";
  };
  const account = (each: CodexAccount): SubscriptionAccount => ({
    id: each.id,
    // The ChatGPT account id names an account only when nothing else does.
    label: each.label ?? (each.email || each.plan ? null : (each.chatgptAccountId ?? null)),
    email: each.email ?? null,
    plan: each.plan ?? null,
    source: each.source ?? null,
    status: each.status,
    refusal: null,
    choosable: true,
    usage: liveMissing(each.id) ? null : codexUsage(each, codex.liveUsage[each.id]),
  });
  return {
    provider: "codex",
    loading: codex.loading && !effective,
    unavailable: Boolean(codex.error),
    accounts: codex.accounts.map(account),
    current: effective ? account(effective) : null,
    currentHidden: !effective && Boolean(selection?.credentialId ?? codex.pinnedAccountId),
    serving: selection !== null,
    automatic: codex.pinnedAccountId === null,
    chosenId: codex.pinnedAccountId,
    waiting: selection?.waiting === true,
    usageCheck: awaitingFirstUsage
      ? "checking"
      : effective && liveMissing(effective.id)
        ? "failed"
        : "idle",
    choosing: codex.pinning,
    choosingTarget: codex.pinningTarget === AUTO ? null : (codex.pinningTarget ?? undefined),
    appliedTo: codex.switchAppliedTo,
    mutationError: codex.mutationError?.message ?? null,
  };
}

function CodexAccountSource(props: IndicatorProps) {
  const codex = useCodexAccounts({
    sessionId: props.sessionId,
    pollIntervalMs: 30_000,
    ...(props.events !== undefined ? { events: props.events } : {}),
  });
  const [checkingUsage, setCheckingUsage] = useState(false);
  const [usageChecked, setUsageChecked] = useState(false);
  const [usageCheckFailed, setUsageCheckFailed] = useState(false);
  const state = codexAccountState(codex, {
    checking: checkingUsage,
    checked: usageChecked,
    failed: usageCheckFailed,
  });
  const waiting = state.waiting;
  return (
    <SubscriptionAccountControl
      state={state}
      onChoose={(id) => {
        // Choosing again while a turn waits retries it on that account.
        // After a failed read the selection is unknown, so the choice is sent.
        if (codex.pinnedAccountId === id && !waiting && !state.unavailable) return;
        void codex.pin(id ?? AUTO);
      }}
      onOpenChange={(open) => {
        if (!open) return;
        setCheckingUsage(true);
        setUsageChecked(false);
        setUsageCheckFailed(false);
        void codex.refreshUsage({ maxAgeMs: LIVE_USAGE_REUSE_MS }).then(
          (ok) => {
            setUsageChecked(ok);
            setUsageCheckFailed(!ok);
            setCheckingUsage(false);
          },
          () => {
            setUsageCheckFailed(true);
            setCheckingUsage(false);
          },
        );
      }}
    />
  );
}
