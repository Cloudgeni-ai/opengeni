// Session-header model-account control for every provider on the shared
// subscription core: shows the account the session uses and lets the person
// choose a shared account or one of their own personal accounts, and turn
// their personal fallback on or off. The server decides what may be chosen.
import { useSessionModelAccount } from "@opengeni/react";
import type { ModelAccountChoiceOption, SessionEvent } from "@opengeni/sdk";
import { ChevronDownIcon, KeyRoundIcon, Loader2Icon, UserRoundIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function accountLabel(account: ModelAccountChoiceOption): string {
  return account.label ?? account.accountEmail ?? account.planType ?? "Account";
}

const REFUSAL_COPY: Record<NonNullable<ModelAccountChoiceOption["refusal"]>, string> = {
  inactive: "Unavailable",
  personal_not_allowed: "Turned off here",
  personal_not_owner_work: "Private chats only",
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

  const shared = accounts.filter((each) => !each.personal);
  const personal = accounts.filter((each) => each.personal);
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
  // Fallback can only reach the person's own accounts where they can serve
  // this chat, so the switch is shown only there.
  const showFallback =
    personal.some((each) => each.choosable) &&
    choice?.personal.connectionsAllowed === true &&
    choice.personal.fallbackAllowed &&
    account.canChangeFallback;
  const ariaLabel = `Model account · ${displayName}`;

  const row = (each: ModelAccountChoiceOption) => {
    const selected = explicit && binding?.connectionId === each.connectionId;
    return (
      <DropdownMenuItem
        key={each.connectionId}
        disabled={account.choosing || !each.choosable}
        onSelect={(event) => {
          event.preventDefault();
          if (selected) return;
          void account.choose(each.connectionId);
        }}
        className="cursor-pointer"
      >
        <span className="min-w-0 flex-1 truncate">{accountLabel(each)}</span>
        {each.refusal ? (
          <DropdownMenuMeta>{REFUSAL_COPY[each.refusal]}</DropdownMenuMeta>
        ) : each.planType ? (
          <DropdownMenuMeta>{each.planType}</DropdownMenuMeta>
        ) : null}
        {account.choosingTarget === each.connectionId ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin" />
        ) : (
          <DropdownMenuCheck checked={selected} className="ml-0" />
        )}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            "group/account relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border border-border/70 bg-surface-2/50 px-1.5 text-fg-muted outline-none transition-[background-color,border-color,color] hover:border-border hover:bg-surface-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
            account.choosing && "opacity-60",
          )}
        >
          {current?.personal ? (
            <UserRoundIcon className="size-3.5 text-current" aria-hidden />
          ) : (
            <KeyRoundIcon className="size-3.5 text-current" aria-hidden />
          )}
          {account.choosing ? (
            <Loader2Icon className="size-2.5 animate-spin text-current" aria-hidden />
          ) : (
            <ChevronDownIcon
              className="size-2.5 shrink-0 opacity-70 transition-opacity group-hover/account:opacity-100"
              aria-hidden
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 flex-col overflow-hidden"
      >
        <div className="shrink-0 px-2.5 pt-1.5 pb-2">
          <p className="text-2xs text-fg-subtle">{explicit ? "Chosen account" : "Account"}</p>
          <p className="truncate text-sm font-medium text-fg">{displayName}</p>
          {current ? (
            <p className="truncate text-2xs text-fg-subtle">
              {current.personal ? "Your account" : "Shared"}
            </p>
          ) : null}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuLabel className="shrink-0">Use for next turn</DropdownMenuLabel>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <DropdownMenuItem
            disabled={account.choosing}
            onSelect={(event) => {
              event.preventDefault();
              if (!explicit) return;
              void account.choose(null);
            }}
            className="cursor-pointer"
          >
            <span className="min-w-0 flex-1 truncate">Automatic</span>
            {account.choosingTarget === null ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin" />
            ) : (
              <DropdownMenuCheck checked={!explicit} className="ml-0" />
            )}
          </DropdownMenuItem>
          {shared.map(row)}
          {personal.length > 0 ? (
            <>
              <DropdownMenuLabel className="pt-2">Your accounts</DropdownMenuLabel>
              {personal.map(row)}
            </>
          ) : null}
          {showFallback ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={choice?.personal.fallbackOptIn ?? false}
                disabled={account.choosing}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => void account.setFallbackOptIn(checked === true)}
                className="cursor-pointer"
              >
                Fall back to my account
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
          {account.mutationError ? (
            <DropdownMenuNote role="alert" className="text-xs text-danger">
              {account.mutationError.message}
            </DropdownMenuNote>
          ) : account.appliedTo === "waiting_turn" ? (
            <DropdownMenuNote>Saved. Retrying the waiting turn.</DropdownMenuNote>
          ) : account.appliedTo === "next_turn" ? (
            <DropdownMenuNote>Saved for the next turn.</DropdownMenuNote>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
