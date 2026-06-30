// The prominent in-session "Account:" control: shows which Codex subscription the
// session's inference runs on and, on click, opens a dropdown to PIN the session
// to a specific account (or "Auto" = follow the workspace default). Structurally a
// clone of SessionSandboxSwitcher, backed by `useCodexAccounts({ sessionId })`
// whose `pin(target)` writes the pin and re-reads; live-flips on the
// `codex.account.switched` / `turn.started` events the hook subscribes to.
//
// Rendered ONLY for codex/* sessions (inference on the user's ChatGPT plan); a
// non-codex session runs on host credits, so the pill is correctly absent.
import { useCodexAccounts } from "@opengeni/react";
import type { CodexAccount, SessionEvent } from "@opengeni/sdk";
import { CheckIcon, ChevronDownIcon, Loader2Icon, SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Canonical value: @opengeni/codex CODEX_MODEL_ID_PREFIX. Inlined to avoid a new
// web dependency on the server-only codex package.
const CODEX_MODEL_ID_PREFIX = "codex/";
const AUTO = "auto";

function accountLabel(account: CodexAccount | undefined | null): string {
  if (!account) return "—";
  return account.label ?? account.email ?? account.plan ?? account.chatgptAccountId ?? "Codex account";
}

// The tighter of the two windows' remaining %, off the CACHED fields (no live
// provider read — the pill is cache-only). null when no usage is cached yet.
function tighterRemaining(account: CodexAccount | undefined | null): number | null {
  if (!account) return null;
  const remainings = [account.fiveHour?.remaining, account.weekly?.remaining].filter(
    (value): value is number => typeof value === "number",
  );
  return remainings.length > 0 ? Math.min(...remainings) : null;
}

/** A compact remaining-quota bar of the tighter window. Reads cache only. */
function MiniBar({ account, className }: { account: CodexAccount | undefined | null; className?: string }) {
  const remaining = tighterRemaining(account);
  if (remaining == null) return null;
  const pct = Math.min(100, Math.max(0, remaining));
  const danger = pct <= 10;
  return (
    <span
      className={`inline-block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-[color:var(--color-surface-2)] ${className ?? ""}`}
      title={`${pct}% remaining`}
    >
      <span
        className={`block h-full rounded-full ${danger ? "bg-amber-500" : "bg-[color:var(--color-brand)]"}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export function CodexAccountIndicator({
  workspaceId: _workspaceId,
  sessionId,
  model,
  events,
}: {
  workspaceId: string;
  sessionId: string;
  model: string;
  events?: SessionEvent[];
}) {
  // Only meaningful for codex/* sessions; host-credit sessions never show it.
  const isCodexSession = model.startsWith(CODEX_MODEL_ID_PREFIX);
  const codex = useCodexAccounts({
    sessionId,
    pollIntervalMs: 30_000,
    enabled: isCodexSession,
    ...(events !== undefined ? { events } : {}),
  });

  if (!isCodexSession) {
    return null;
  }

  const effective = codex.accounts.find((account) => account.id === codex.effectiveAccountId) ?? null;
  const triggerLabel = accountLabel(effective);
  const plan = effective?.plan ?? null;
  const hasAccounts = codex.accounts.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 max-w-[14rem] gap-1 rounded-full border border-transparent px-2 text-xs text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
        >
          <SparklesIcon className="size-3 shrink-0 text-[color:var(--color-brand)]" />
          <span className="hidden truncate text-[color:var(--color-fg-subtle)] sm:inline">Account:</span>
          <span className="truncate font-medium text-[color:var(--color-fg)]">{triggerLabel}</span>
          {plan ? <span className="hidden shrink-0 text-[color:var(--color-fg-subtle)] md:inline">· {plan}</span> : null}
          <MiniBar account={effective} className="hidden sm:inline-block" />
          {codex.pinning ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-64 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl"
      >
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">
          Run inference on
        </DropdownMenuLabel>

        {/* Auto (follow the workspace active pointer). */}
        <DropdownMenuItem
          disabled={codex.pinning}
          onSelect={(event) => {
            event.preventDefault();
            if (codex.pinnedAccountId === null) {
              return; // already auto
            }
            void codex.pin(AUTO);
          }}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
        >
          <SparklesIcon className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]" />
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
                if (codex.pinnedAccountId === account.id) {
                  return; // already pinned to this one
                }
                void codex.pin(account.id);
              }}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{accountLabel(account)}</span>
              <MiniBar account={account} />
              {account.status !== "active" ? (
                <span className="shrink-0 text-[10px] text-amber-500">{account.status === "needs_relogin" ? "relogin" : account.status}</span>
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
          <p className="px-2 pt-1 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">No Codex subscriptions connected.</p>
        ) : null}
        {codex.mutationError ? (
          <p className="px-2 pt-1 text-[11px] leading-4 text-[color:var(--color-danger)]">
            Switch failed: {codex.mutationError.message}
          </p>
        ) : (
          <p className="px-2 pt-1 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">Applies next turn.</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
