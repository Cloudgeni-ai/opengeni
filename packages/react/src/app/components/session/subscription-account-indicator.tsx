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
} from "@opengeni/sdk";

import { useCodexAccounts } from "../../../hooks/use-codex-accounts";
import { useSessionModelAccount } from "../../../hooks/use-session-model-account";
import { Skeleton } from "../../../ui/skeleton";
import { BillingClassMark } from "../billing-class-mark";
import {
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
      <Skeleton className="h-6 w-11 shrink-0 rounded-full" aria-label={`Loading ${name} account`} />
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

function sharedAccount(option: ModelAccountChoiceOption): SubscriptionAccount {
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
  const choice = account.choice;
  const options = (choice?.accounts ?? []).filter((each) => each.provider === provider);
  const binding =
    choice?.bindings?.find((each) => each.provider === provider) ??
    (choice?.binding?.provider === provider ? choice.binding : null);
  const explicit = binding?.choice === "explicit";
  const serving =
    choice?.serving &&
    choice.serving.turnId === props.servingTurnId &&
    choice.serving.provider === provider
      ? choice.serving
      : null;
  const currentId = serving ? serving.connectionId : binding?.connectionId;
  const current = currentId
    ? (options.find((each) => each.connectionId === currentId) ?? null)
    : null;
  const state: SubscriptionAccountState = {
    provider,
    loading: account.loading && !choice,
    unavailable: !choice,
    accounts: options.map(sharedAccount),
    current: current ? sharedAccount(current) : null,
    currentHidden: !current && (explicit || serving !== null),
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
  return (
    <SubscriptionAccountControl
      state={state}
      onChoose={(id) => {
        if (id === null ? !explicit : explicit && binding?.connectionId === id) return;
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

function codexUsage(
  account: CodexAccount,
  live: CodexUsageMap[string] | undefined,
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
        status: usedPercent === null ? "unknown" : usedPercent >= 100 ? "exhausted" : "ok",
      },
    ];
  };
  const windows = [
    ...window("five_hour", account.fiveHour),
    ...window("seven_day", account.weekly),
  ];
  if (windows.length === 0) return null;
  return {
    observedAt: live?.usage?.fetchedAt ?? account.usageCheckedAt ?? null,
    windows,
    exhaustedUntil: null,
    exhaustedKind: null,
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
  // Live readings from an earlier check (this menu, another session's, or
  // Settings) stay visible while a new check runs instead of flashing away.
  const awaitingFirstUsage = checkingUsage && codex.liveUsageUpdatedAt === null;
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
    return (
      usageCheckFailed || (usageChecked && !status) || status === "error" || status === "no-data"
    );
  };
  const account = (each: CodexAccount): SubscriptionAccount => ({
    id: each.id,
    label: each.label ?? null,
    email: each.email ?? null,
    plan: each.plan ?? null,
    source: each.source ?? null,
    status: each.status,
    refusal: null,
    choosable: true,
    usage: liveMissing(each.id) ? null : codexUsage(each, codex.liveUsage[each.id]),
  });
  const waiting = selection?.waiting === true;
  const state: SubscriptionAccountState = {
    provider: "codex",
    loading: codex.loading && !effective,
    unavailable: Boolean(codex.error),
    accounts: codex.accounts.map(account),
    current: effective ? account(effective) : null,
    currentHidden: !effective && Boolean(selection?.credentialId ?? codex.pinnedAccountId),
    automatic: codex.pinnedAccountId === null,
    chosenId: codex.pinnedAccountId,
    waiting,
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
  return (
    <SubscriptionAccountControl
      state={state}
      onChoose={(id) => {
        // Choosing again while a turn waits retries it on that account.
        if (codex.pinnedAccountId === id && !waiting) return;
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
