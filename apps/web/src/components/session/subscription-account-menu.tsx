// Shared presentation extracted from the Codex subscription-account dropdown.
// Adapters own loading, authorization, usage freshness, and selection semantics.
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type SubscriptionAccountMenuRow = {
  id: string;
  label: string;
  plan?: string | null;
  status?: string | null;
  detail?: string;
  personal?: boolean;
  disabled?: boolean;
  /** Only supplied when the adapter has a trustworthy quota reading. */
  remaining?: number | null;
  /** Cached window readings, not an aggregate capacity/eligibility estimate. */
  usageSummary?: string | undefined;
};

export type SubscriptionAccountUsageWindow = {
  label: string;
  remaining?: number;
  usedPercent?: number | null;
  detail?: string;
};

function UsageRow({ label, remaining, usedPercent, detail }: SubscriptionAccountUsageWindow) {
  const value = remaining ?? usedPercent;
  const known = typeof value === "number" && Number.isFinite(value);
  const pct = known ? Math.min(100, Math.max(0, value)) : 0;
  const measure = remaining !== undefined ? "remaining" : "used";
  const text = known ? `${Math.round(value)}% ${measure}` : "Unknown";
  return (
    <div className="space-y-0.5 text-2xs text-fg-subtle">
      <div className="flex items-center gap-2">
        <span className="max-w-28 min-w-10 shrink-0 truncate" title={label}>
          {label}
        </span>
        {known ? (
          <span
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label={`${label} ${measure}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={text}
          >
            <span
              className={cn(
                "block h-full rounded-full",
                (measure === "remaining" ? pct <= 10 : pct >= 90)
                  ? "bg-status-waiting"
                  : "bg-brand",
              )}
              style={{ width: `${pct}%` }}
            />
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 whitespace-nowrap text-right tabular-nums">{text}</span>
      </div>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

function MiniBar({ remaining }: { remaining: number }) {
  const pct = Math.min(100, Math.max(0, remaining));
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-2xs text-fg-subtle"
      title={`${Math.round(pct)}% remaining in the tighter usage window`}
    >
      <span className="h-1 w-8 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <span
          className={cn("block h-full rounded-full", pct <= 10 ? "bg-status-waiting" : "bg-brand")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="whitespace-nowrap tabular-nums">{Math.round(pct)}% remaining</span>
    </span>
  );
}

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
  identity?: string | null;
  tone?: "ok" | "warn" | "bad";
  usage: {
    checking?: boolean;
    unavailable?: boolean;
    message?: string;
    note?: string;
    windows?: SubscriptionAccountUsageWindow[];
  };
  accounts: SubscriptionAccountMenuRow[];
  selectedId: string | null;
  automaticSelected: boolean;
  choosing: boolean;
  choosingTarget: string | null | undefined;
  actionLabel?: string;
  automaticLabel?: string;
  emptyMessage?: string;
  error?: string | null;
  note: string;
  onOpenChange?: (open: boolean) => void;
  onChoose: (connectionId: string | null) => void;
}) {
  const row = (account: SubscriptionAccountMenuRow) => (
    <DropdownMenuItem
      key={account.id}
      disabled={choosing || account.disabled}
      title={account.detail}
      onSelect={(event) => {
        event.preventDefault();
        onChoose(account.id);
      }}
      className="cursor-pointer"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{account.label}</span>
        {account.usageSummary ? (
          <span className="block truncate text-2xs text-fg-subtle" title={account.usageSummary}>
            {account.usageSummary}
          </span>
        ) : null}
      </span>
      {account.plan ? <DropdownMenuMeta>{account.plan}</DropdownMenuMeta> : null}
      {account.remaining != null ? <MiniBar remaining={account.remaining} /> : null}
      {account.status ? (
        <span className="shrink-0 text-xs text-status-waiting">{account.status}</span>
      ) : null}
      {choosingTarget === account.id ? (
        <Loader2Icon className="size-4 shrink-0 animate-spin" />
      ) : (
        <DropdownMenuCheck checked={account.id === selectedId} className="ml-0" />
      )}
    </DropdownMenuItem>
  );
  const personal = accounts.filter((account) => account.personal);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            "group/account relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border border-border/70 bg-surface-2/50 px-1.5 text-fg-muted outline-none transition-[background-color,border-color,color] hover:border-border hover:bg-surface-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
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
        className="flex max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-72 flex-col overflow-hidden"
      >
        <div className="shrink-0 space-y-2 px-2.5 pt-1.5 pb-2">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-fg">
              {headerMark}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-2xs text-fg-subtle">{selectionLabel}</p>
              <p className="truncate text-sm font-medium text-fg">{displayName}</p>
              {identity ? (
                <p className="truncate text-2xs text-fg-subtle" title={identity}>
                  {identity}
                </p>
              ) : null}
              <p className="truncate text-2xs text-fg-subtle" title={metadata}>
                {metadata}
              </p>
            </div>
          </div>
          {usage.checking ? (
            <p className="text-2xs text-fg-subtle">Checking usage…</p>
          ) : usage.unavailable ? (
            <p className="text-2xs text-fg-subtle">Usage unavailable</p>
          ) : usage.message ? (
            <p className="text-2xs text-fg-subtle">{usage.message}</p>
          ) : (
            <div className="max-h-36 space-y-1.5 overflow-y-auto overscroll-contain">
              {usage.windows?.map((window) => (
                <UsageRow key={window.label} {...window} />
              ))}
            </div>
          )}
          {usage.note ? <p className="text-2xs text-fg-subtle">{usage.note}</p> : null}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuLabel className="shrink-0">{actionLabel}</DropdownMenuLabel>
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
