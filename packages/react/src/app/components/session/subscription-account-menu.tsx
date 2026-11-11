// The subscription-account dropdown every provider shares. Its content comes
// from `subscriptionAccountMenuContent`; data sources own loading,
// authorization, usage freshness and selection.
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { SubscriptionWindow } from "../../lib/subscription-accounts";
import { SubscriptionUsageWindows } from "../models/subscription-usage";

export type SubscriptionAccountMenuRow = {
  id: string;
  /** The account's full name (label or email); wraps, never truncated. */
  label: string;
  /** The email under a label that differs from it. */
  email?: string | null | undefined;
  /** The plan's own name, only when the listed accounts' plans differ. */
  plan?: string | null | undefined;
  status?: string | null;
  /** `next_turn`: the chosen account. `in_use`: the account the chat runs on. */
  mark?: "next_turn" | "in_use" | null | undefined;
  /** Every reported window; null while hidden (the current account, a live check). */
  windows?: SubscriptionWindow[] | null | undefined;
  /** Words instead of windows: no reading yet, or a limit no window shows. */
  usageMessage?: string | null | undefined;
  detail?: string;
  personal?: boolean;
  disabled?: boolean;
};

export type SubscriptionAccountMenuUsage = {
  checking?: boolean | undefined;
  unavailable?: boolean | undefined;
  message?: string | undefined;
  note?: string | undefined;
  windows?: SubscriptionWindow[] | undefined;
};

const MARK_TEXT = { next_turn: "Next turn", in_use: "In use" } as const;

export function SubscriptionAccountMenu({
  ariaLabel,
  triggerMark,
  headerMark,
  selectionLabel,
  displayName,
  metadata,
  identity,
  tone = "ok",
  usage,
  accounts,
  plan,
  selectedId,
  automaticSelected,
  choosing,
  choosingTarget,
  actionLabel = "Use for next turn",
  automaticLabel = "Automatic",
  emptyMessage,
  error,
  note,
  onOpenChange,
  onChoose,
}: {
  ariaLabel: string;
  triggerMark: ReactNode;
  headerMark: ReactNode;
  selectionLabel: string;
  displayName: string;
  metadata: string;
  identity?: string | null | undefined;
  tone?: "ok" | "warn" | "bad" | undefined;
  usage: SubscriptionAccountMenuUsage;
  accounts: SubscriptionAccountMenuRow[];
  /** The plan every listed account shares, shown once beside the list. */
  plan?: string | null | undefined;
  selectedId: string | null;
  automaticSelected: boolean;
  choosing: boolean;
  choosingTarget: string | null | undefined;
  actionLabel?: string | undefined;
  automaticLabel?: string | undefined;
  emptyMessage?: string | undefined;
  error?: string | null | undefined;
  note: string;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onChoose: (connectionId: string | null) => void;
}) {
  const row = (account: SubscriptionAccountMenuRow) => (
    <DropdownMenuItem
      key={account.id}
      disabled={choosing || account.disabled}
      title={account.detail}
      data-mark={account.mark ?? undefined}
      onSelect={(event) => {
        event.preventDefault();
        onChoose(account.id);
      }}
      className="cursor-pointer items-start"
    >
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-slot="subscription-account-name"
            className={cn(
              "min-w-0 flex-1 [overflow-wrap:anywhere]",
              account.mark === "next_turn" && "font-medium",
            )}
          >
            {account.label}
          </span>
          {account.plan ? (
            <span className="shrink-0 text-xs text-fg-muted">{account.plan}</span>
          ) : null}
        </span>
        {account.email ? (
          <span className="block text-2xs leading-4 text-fg-subtle [overflow-wrap:anywhere]">
            {account.email}
          </span>
        ) : null}
        {account.mark || account.status ? (
          <span className="flex flex-wrap items-center gap-x-2 text-2xs leading-4">
            {account.mark ? (
              <span
                className={cn(
                  "font-medium",
                  account.mark === "next_turn" ? "text-brand" : "text-fg-muted",
                )}
              >
                {MARK_TEXT[account.mark]}
              </span>
            ) : null}
            {account.status ? <span className="text-status-waiting">{account.status}</span> : null}
          </span>
        ) : null}
        {account.windows && account.windows.length > 0 ? (
          <SubscriptionUsageWindows windows={account.windows} empty={null} />
        ) : null}
        {account.usageMessage ? (
          <span className="block text-2xs leading-4 text-fg-subtle">{account.usageMessage}</span>
        ) : null}
      </span>
      {choosingTarget === account.id ? (
        <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin" />
      ) : (
        <DropdownMenuCheck checked={account.id === selectedId} className="mt-0.5 ml-0" />
      )}
    </DropdownMenuItem>
  );
  const personal = accounts.filter((account) => account.personal);
  return (
    <DropdownMenu {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            "group/account relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border border-border/70 bg-surface-2/50 px-1.5 text-fg-muted outline-hidden transition-[background-color,border-color,color] hover:border-border hover:bg-surface-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
            choosing && "opacity-60",
          )}
        >
          {triggerMark}
          {choosing ? (
            <Loader2Icon className="size-2.5 animate-spin text-current" aria-hidden />
          ) : (
            <ChevronDownIcon
              className="size-2.5 shrink-0 opacity-70 transition-opacity group-hover/account:opacity-100"
              aria-hidden
            />
          )}
          {tone !== "ok" ? (
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-surface",
                tone === "bad" ? "bg-destructive" : "bg-status-waiting",
              )}
              aria-hidden
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(40rem,var(--radix-dropdown-menu-content-available-height))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden"
      >
        <div className="shrink-0 space-y-2 px-2.5 pt-1.5 pb-2">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-fg">
              {headerMark}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-2xs text-fg-subtle">{selectionLabel}</p>
              <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{displayName}</p>
              {identity ? (
                <p className="text-2xs text-fg-subtle [overflow-wrap:anywhere]">{identity}</p>
              ) : null}
              <p className="text-2xs text-fg-subtle">{metadata}</p>
            </div>
          </div>
          {usage.checking ? (
            <p className="text-2xs text-fg-subtle">Checking usage…</p>
          ) : usage.unavailable ? (
            <p className="text-2xs text-fg-subtle">Usage unavailable</p>
          ) : (
            <>
              {usage.windows && usage.windows.length > 0 ? (
                <SubscriptionUsageWindows
                  windows={usage.windows}
                  layout="stack"
                  empty={null}
                  className="max-h-36 overflow-y-auto overscroll-contain text-xs leading-5"
                />
              ) : null}
              {usage.message ? <p className="text-2xs text-fg-subtle">{usage.message}</p> : null}
            </>
          )}
          {usage.note ? <p className="text-2xs text-fg-subtle">{usage.note}</p> : null}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuLabel className="flex shrink-0 items-baseline justify-between gap-3">
          <span>{actionLabel}</span>
          {plan ? <span className="font-normal text-fg-subtle">{plan}</span> : null}
        </DropdownMenuLabel>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <DropdownMenuItem
            disabled={choosing}
            onSelect={(event) => {
              event.preventDefault();
              onChoose(null);
            }}
            className="cursor-pointer"
          >
            <span className="min-w-0 flex-1 truncate">{automaticLabel}</span>
            {choosingTarget === null ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin" />
            ) : (
              <DropdownMenuCheck checked={automaticSelected} className="ml-0" />
            )}
          </DropdownMenuItem>
          {accounts.filter((account) => !account.personal).map(row)}
          {personal.length > 0 ? (
            <>
              <DropdownMenuLabel className="pt-2">Your accounts</DropdownMenuLabel>
              {personal.map(row)}
            </>
          ) : null}
          {accounts.length === 0 && emptyMessage ? (
            <DropdownMenuNote>{emptyMessage}</DropdownMenuNote>
          ) : null}
          {error ? (
            <DropdownMenuNote role="alert" className="text-xs text-danger">
              {error}
            </DropdownMenuNote>
          ) : (
            <p className="px-2.5 pt-1.5 pb-1 text-xs text-fg-muted">{note}</p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
