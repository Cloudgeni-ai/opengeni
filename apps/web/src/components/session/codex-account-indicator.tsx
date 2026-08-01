// Session-header Codex control: the same ChatGPT mark that identifies the Codex
// rail doubles as the account switcher trigger (not a second icon). Menu shows
// active subscription, status/usage, and pin switching. Host-credit: null.
import { useCodexAccounts } from "@opengeni/react";
import type { CodexAccount, CodexUsageWindow, SessionEvent } from "@opengeni/sdk";
import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";

import { BillingClassMark } from "@/components/billing-class-mark";
import { ChatGptMark } from "@/components/chatgpt-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Canonical value: @opengeni/codex CODEX_MODEL_ID_PREFIX. Inlined to avoid a new
// web dependency on the server-only codex package.
const CODEX_MODEL_ID_PREFIX = "codex/";
const AUTO = "auto";

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

function UsageRow(props: { label: string; window: CodexUsageWindow | null | undefined }) {
  if (!props.window) return null;
  const pct = Math.min(100, Math.max(0, props.window.remaining));
  const danger = pct <= 10;
  return (
    <div className="flex items-center gap-2 text-2xs text-fg-subtle">
      <span className="w-10 shrink-0">{props.label}</span>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span
          className={cn("block h-full rounded-full", danger ? "bg-status-waiting" : "bg-brand")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

function MiniBar({ account }: { account: CodexAccount | undefined | null }) {
  const remaining = tighterRemaining(account);
  if (remaining == null) return null;
  const pct = Math.min(100, Math.max(0, remaining));
  return (
    <span
      className="inline-block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-surface-2"
      title={`${Math.round(pct)}% remaining`}
    >
      <span
        className={cn(
          "block h-full rounded-full",
          pct <= 10 ? "bg-status-waiting" : "bg-brand",
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
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

  if (!modelReady) {
    return (
      <Skeleton className="h-6 w-11 shrink-0 rounded-full" aria-label="Loading Codex account" />
    );
  }

  if (!isCodexSession) {
    return null;
  }

  const effective =
    codex.accounts.find((account) => account.id === codex.effectiveAccountId) ?? null;
  const accountsPending = codex.loading && !effective;
  if (accountsPending) {
    return (
      <Skeleton className="h-6 w-11 shrink-0 rounded-full" aria-label="Loading Codex account" />
    );
  }

  const tone = statusTone(effective);
  const hasAccounts = codex.accounts.length > 0;
  const ariaLabel = effective
    ? `Switch Codex account · ${accountLabel(effective)}${effective.plan ? ` · ${effective.plan}` : ""}`
    : "Switch Codex account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            "group/codex relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border border-border/70 bg-surface-2/50 px-1.5 text-fg-muted outline-none transition-[background-color,border-color,color] hover:border-border hover:bg-surface-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
            codex.pinning && "opacity-60",
          )}
        >
          <BillingClassMark
            billingClass="codex_subscription"
            className="size-3.5 text-current"
            aria-label=""
          />
          {codex.pinning ? (
            <Loader2Icon className="size-2.5 animate-spin text-current" aria-hidden />
          ) : (
            <ChevronDownIcon
              className="size-2.5 shrink-0 opacity-70 transition-opacity group-hover/codex:opacity-100"
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
        className="flex max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 flex-col overflow-hidden rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <div className="shrink-0 space-y-2 px-2 pt-1.5 pb-2">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-fg">
              <ChatGptMark className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{accountLabel(effective)}</p>
              <p className="truncate text-2xs text-fg-subtle">
                {[effective?.plan, effective?.status === "active" ? null : effective?.status]
                  .filter(Boolean)
                  .join(" · ") || "Codex subscription"}
              </p>
            </div>
          </div>
          {effective ? (
            <div className="space-y-1.5">
              <UsageRow label="5h" window={effective.fiveHour} />
              <UsageRow label="Week" window={effective.weekly} />
            </div>
          ) : null}
        </div>

        <DropdownMenuSeparator className="shrink-0" />

        <DropdownMenuLabel className="shrink-0 px-2 pt-1 pb-1 text-xs font-normal text-fg-subtle">
          Run next turn on
        </DropdownMenuLabel>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <DropdownMenuItem
            disabled={codex.pinning}
            onSelect={(event) => {
              event.preventDefault();
              if (codex.pinnedAccountId === null) return;
              void codex.pin(AUTO);
            }}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">Auto (workspace default)</span>
            {codex.pinningTarget === AUTO ? (
              <Loader2Icon className="ml-1 size-4 shrink-0 animate-spin" />
            ) : codex.pinnedAccountId === null ? (
              <CheckIcon className="ml-1 size-4 shrink-0" />
            ) : null}
          </DropdownMenuItem>

          {codex.accounts.map((account) => {
            const isEffective = account.id === codex.effectiveAccountId;
            const isPinning = codex.pinningTarget === account.id;
            return (
              <DropdownMenuItem
                key={account.id}
                disabled={codex.pinning}
                onSelect={(event) => {
                  event.preventDefault();
                  if (codex.pinnedAccountId === account.id) return;
                  void codex.pin(account.id);
                }}
                className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{accountLabel(account)}</span>
                {account.plan ? (
                  <span className="shrink-0 text-2xs text-fg-subtle">{account.plan}</span>
                ) : null}
                <MiniBar account={account} />
                {account.status !== "active" ? (
                  <span className="shrink-0 text-2xs text-status-waiting">
                    {account.status === "needs_relogin" ? "relogin" : account.status}
                  </span>
                ) : null}
                {isPinning ? (
                  <Loader2Icon className="ml-1 size-4 shrink-0 animate-spin" />
                ) : isEffective ? (
                  <CheckIcon className="ml-1 size-4 shrink-0" />
                ) : null}
              </DropdownMenuItem>
            );
          })}

          {!hasAccounts ? (
            <p className="px-2 pt-1 text-2xs text-fg-subtle">No Codex subscriptions connected.</p>
          ) : null}
          {codex.mutationError ? (
            <p className="px-2 pt-1 text-2xs text-danger">
              Switch failed: {codex.mutationError.message}
            </p>
          ) : (
            <p className="px-2 pt-1 text-2xs text-fg-subtle">Applies next turn.</p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
