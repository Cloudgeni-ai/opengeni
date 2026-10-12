// Session-header model-account control for every provider on the shared
// subscription core: shows the account the session uses and lets the person
// choose Automatic, a shared account, or one of their own personal accounts.
// The server decides what may be chosen.
import { useSessionModelAccount } from "@opengeni/react";
import type { ModelAccountChoiceOption, SessionEvent } from "@opengeni/sdk";
import { BillingClassMark, type BillingClass } from "@/components/billing-class-mark";
import { SubscriptionAccountMenu } from "@/components/session/subscription-account-menu";

function accountLabel(account: ModelAccountChoiceOption): string {
  return account.label ?? account.accountEmail ?? account.planType ?? "Account";
}

const REFUSAL_COPY: Record<NonNullable<ModelAccountChoiceOption["refusal"]>, string> = {
  inactive: "Unavailable",
  personal_not_allowed: "Turned off here",
  personal_not_owner_work: "Private chats only",
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

function accountStatus(account: ModelAccountChoiceOption): string | null {
  // Inactive is a broad refusal; retain the actual status when it explains why.
  if (account.refusal && account.refusal !== "inactive") return REFUSAL_COPY[account.refusal];
  if (account.status !== "active") return STATUS_COPY[account.status] ?? account.status;
  return account.refusal ? REFUSAL_COPY[account.refusal] : null;
}

function accountSource(account: ModelAccountChoiceOption): string {
  return account.personal
    ? "Your account"
    : account.source === "workspace"
      ? "This workspace"
      : "Organization";
}

const PROVIDER_MARK: Record<string, BillingClass> = {
  codex: "codex_subscription",
  claude: "claude_subscription",
  supergrok: "supergrok_subscription",
};

export function ModelAccountIndicator({
  workspaceId,
  sessionId,
  organizationId,
  provider,
  events,
}: {
  workspaceId: string;
  sessionId: string;
  organizationId: string | null;
  /** The session model's subscription provider; only its accounts are offered. */
  provider: string;
  events?: SessionEvent[];
}) {
  const account = useSessionModelAccount({
    workspaceId,
    sessionId,
    organizationId,
    pollIntervalMs: 60_000,
    ...(events !== undefined ? { events } : {}),
  });
  const choice = account.choice;
  const accounts = (choice?.accounts ?? []).filter((each) => each.provider === provider);
  if (accounts.length === 0) return null;

  const binding = choice?.binding?.provider === provider ? choice.binding : null;
  const explicit = binding?.choice === "explicit";
  const current = binding?.connectionId
    ? (accounts.find((each) => each.connectionId === binding.connectionId) ?? null)
    : null;
  const displayName = current
    ? accountLabel(current)
    : explicit
      ? "Account unavailable"
      : "Automatic";
  const ariaLabel = `Model account · ${displayName}`;
  const billingClass = PROVIDER_MARK[provider] ?? "external";
  const currentStatus = current ? accountStatus(current) : null;

  return (
    <SubscriptionAccountMenu
      ariaLabel={ariaLabel}
      triggerMark={
        <BillingClassMark
          billingClass={billingClass}
          className="size-3.5 text-current"
          aria-label=""
        />
      }
      headerMark={<BillingClassMark billingClass={billingClass} className="size-4 text-current" />}
      selectionLabel={
        explicit ? "Chosen account" : current ? "Current account" : "Account selection"
      }
      displayName={displayName}
      identity={current?.accountEmail !== displayName ? current?.accountEmail : null}
      metadata={
        current
          ? [current.planType, accountSource(current), currentStatus].filter(Boolean).join(" · ")
          : "Subscription account"
      }
      tone={
        currentStatus
          ? current?.status === "needs_relogin" || current?.status === "error"
            ? "bad"
            : "warn"
          : "ok"
      }
      // The neutral endpoint has no usage windows or refresh API. Do not borrow
      // a provider's legacy inventory/selection path to manufacture readings.
      usage={{ unavailable: true }}
      accounts={accounts.map((each) => ({
        id: each.connectionId,
        label: accountLabel(each),
        plan: each.planType,
        status: accountStatus(each),
        detail: [
          accountLabel(each),
          each.accountEmail,
          each.planType,
          accountSource(each),
          accountStatus(each),
        ]
          .filter(Boolean)
          .join(" · "),
        personal: each.personal,
        disabled: !each.choosable,
      }))}
      selectedId={explicit ? binding.connectionId : null}
      automaticSelected={!explicit}
      choosing={account.choosing}
      choosingTarget={account.choosingTarget}
      error={account.mutationError?.message}
      note={
        account.appliedTo === "waiting_turn"
          ? "Selection saved. Capacity is being rechecked."
          : account.appliedTo === "next_turn"
            ? "Selection saved for the next turn."
            : "Applies next turn. The current turn keeps its account."
      }
      onChoose={(id) => {
        if (id === null ? !explicit : explicit && binding.connectionId === id) return;
        void account.choose(id);
      }}
    />
  );
}
