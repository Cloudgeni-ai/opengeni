// Session-header Codex control: the same ChatGPT mark that identifies the Codex
// rail doubles as the account switcher trigger (not a second icon). Menu shows
// active subscription, status/usage, and pin switching. Host-credit: null.
import { useCodexAccounts } from "@opengeni/react";
import type { CodexAccount, SessionEvent } from "@opengeni/sdk";
import { useState } from "react";

import { BillingClassMark } from "@/components/billing-class-mark";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { SubscriptionAccountMenu } from "@/components/session/subscription-account-menu";
import { Skeleton } from "@/components/ui/skeleton";

// Canonical value: @opengeni/codex CODEX_MODEL_ID_PREFIX. Inlined to avoid a new
// web dependency on the server-only codex package.
const CODEX_MODEL_ID_PREFIX = "codex/";
const AUTO = "auto";
// Reopening the menu reuses live readings this recent instead of asking the
// provider again; older ones stay on screen while the menu re-checks.
const LIVE_USAGE_REUSE_MS = 30_000;

function accountLabel(account: CodexAccount | undefined | null): string {
  if (!account) return "—";
  return (
    account.label ?? account.email ?? account.plan ?? account.chatgptAccountId ?? "Codex account"
  );
}

function tighterRemaining(account: CodexAccount | undefined | null): number | null {
  if (!account) return null;
  const remainings = [account.fiveHour?.remaining, account.weekly?.remaining].filter(
    (value): value is number => typeof value === "number",
  );
  return remainings.length > 0 ? Math.min(...remainings) : null;
}

function statusTone(account: CodexAccount | undefined | null): "ok" | "warn" | "bad" {
  if (!account) return "ok";
  if (account.status === "needs_relogin" || account.status === "error") return "bad";
  const remaining = tighterRemaining(account);
  if (remaining != null && remaining <= 10) return "warn";
  return "ok";
}

export function CodexAccountIndicator({
  workspaceId: _workspaceId,
  sessionId,
  model,
  modelReady = true,
  events,
}: {
  workspaceId: string;
  sessionId: string;
  model: string;
  /** False while the session's admitted model identity is still loading. */
  modelReady?: boolean;
  events?: SessionEvent[];
}) {
  const isCodexSession = model.startsWith(CODEX_MODEL_ID_PREFIX);
  const codex = useCodexAccounts({
    sessionId,
    pollIntervalMs: 30_000,
    enabled: modelReady && isCodexSession,
    ...(events !== undefined ? { events } : {}),
  });
  const [checkingUsage, setCheckingUsage] = useState(false);
  const [usageChecked, setUsageChecked] = useState(false);
  const [usageCheckFailed, setUsageCheckFailed] = useState(false);
  // Live readings from an earlier check (this menu, another session's, or
  // Settings) stay visible while a new check runs instead of flashing away.
  const hasLiveUsage = codex.liveUsageUpdatedAt !== null;
  const awaitingFirstUsage = checkingUsage && !hasLiveUsage;

  if (!modelReady) {
    return (
      <Skeleton className="h-6 w-11 shrink-0 rounded-full" aria-label="Loading Codex account" />
    );
  }

  if (!isCodexSession) {
    return null;
  }

  const current = codex.currentSelection;
  const effective =
    (current ? codex.currentAccount : null) ??
    codex.accounts.find(
      (account) => account.id === (current ? current.credentialId : codex.pinnedAccountId),
    ) ??
    null;
  const selectionLabel = current
    ? current.waiting
      ? "Limit reached"
      : "Current account"
    : "Account selection";
  const displayName = effective
    ? accountLabel(effective)
    : current?.credentialId
      ? "Account unavailable"
      : current && !current.waiting
        ? "Selecting account"
        : "Automatic selection";
  const accountsPending = codex.loading && !effective;
  if (accountsPending) {
    return (
      <Skeleton className="h-6 w-11 shrink-0 rounded-full" aria-label="Loading Codex account" />
    );
  }

  const tone = statusTone(effective);
  const ariaLabel = `Switch Codex account · ${selectionLabel} · ${displayName}`;
  const liveStatus = effective ? codex.liveUsage[effective.id]?.status : null;
  const usageUnavailable =
    usageCheckFailed ||
    (usageChecked && !liveStatus) ||
    liveStatus === "error" ||
    liveStatus === "no-data";

  return (
    <SubscriptionAccountMenu
      ariaLabel={ariaLabel}
      triggerMark={
        <BillingClassMark
          billingClass="codex_subscription"
          className="size-3.5 text-current"
          aria-label=""
        />
      }
      headerMark={<ChatGptMark className="size-4" />}
      selectionLabel={selectionLabel}
      displayName={displayName}
      metadata={
        [effective?.plan, effective?.status === "active" ? null : effective?.status]
          .filter(Boolean)
          .join(" · ") || "Codex subscription"
      }
      tone={tone}
      usage={{
        checking: awaitingFirstUsage,
        unavailable: usageUnavailable,
        windows: [
          ...(effective?.fiveHour
            ? [{ label: "5h", remaining: effective.fiveHour.remaining }]
            : []),
          ...(effective?.weekly ? [{ label: "Week", remaining: effective.weekly.remaining }] : []),
        ],
      }}
      accounts={codex.accounts.map((account) => ({
        id: account.id,
        label: accountLabel(account),
        plan: account.plan,
        status:
          account.status === "active"
            ? null
            : account.status === "needs_relogin"
              ? "relogin"
              : account.status,
        remaining:
          account.id !== effective?.id &&
          !awaitingFirstUsage &&
          !usageCheckFailed &&
          (!usageChecked || codex.liveUsage[account.id]) &&
          codex.liveUsage[account.id]?.status !== "error" &&
          codex.liveUsage[account.id]?.status !== "no-data"
            ? tighterRemaining(account)
            : null,
      }))}
      selectedId={codex.pinnedAccountId}
      automaticSelected={codex.pinnedAccountId === null}
      choosing={codex.pinning}
      choosingTarget={codex.pinningTarget === AUTO ? null : (codex.pinningTarget ?? undefined)}
      actionLabel={current?.waiting ? "Retry with" : "Use for next turn"}
      automaticLabel={current?.waiting ? "Auto" : "Auto (workspace default)"}
      emptyMessage={codex.error ? "Accounts unavailable." : "No Codex subscriptions connected."}
      error={codex.mutationError ? `Switch failed: ${codex.mutationError.message}` : null}
      note={
        codex.switchAppliedTo === "waiting_turn"
          ? "Selection saved. Capacity is being rechecked."
          : codex.switchAppliedTo === "next_turn"
            ? "Selection saved for the next turn."
            : current?.waiting
              ? "Changing accounts retries the waiting turn."
              : "Applies next turn. The current turn keeps its account."
      }
      onChoose={(id) => {
        if (codex.pinnedAccountId === id && !current?.waiting) return;
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
