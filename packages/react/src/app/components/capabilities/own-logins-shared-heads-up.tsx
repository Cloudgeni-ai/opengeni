import type { ConnectionMetadata } from "@opengeni/sdk";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ComposerMenuSwitchIndicator } from "../../../ui/composer-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { t } from "../../lib/console-text";
import { CapabilityLogo } from "./capability-logo";
import { ownLoginCanStopHere } from "./own-login-turned-on";
import type {
  ConnectedAccountGroup,
  ConnectionAccountChoices,
} from "./session-connection-accounts";

/** One of your own accounts this chat uses, however many times it is connected. */
export type OwnLoginInUse = {
  /** Stable for the account: its connector and who it signs in as (or its connection). */
  key: string;
  /** The connector it is used through. */
  serverId: string;
  /** Every connection of this account the chat would use (an account can be connected twice). */
  accounts: ConnectionMetadata[];
  /** The connector's name, plus the account when you use more than one account of it. */
  label: string;
};

/**
 * The viewer's own logins this chat's next message would use: their accounts
 * among the chat's connectors, as chosen (no choice means every eligible
 * account). Each account counts once: connections of one connector that sign
 * in as the same account are one login. A connection that names no account
 * stays on its own, so different accounts never merge.
 */
export function ownLoginsInUse(
  groups: readonly ConnectedAccountGroup[],
  choices: ConnectionAccountChoices,
  subjectId: string,
): OwnLoginInUse[] {
  const used: (OwnLoginInUse & { identity: string; connector: string })[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const chosen = choices[group.serverId];
    for (const account of group.accounts) {
      if (
        account.subjectId !== subjectId ||
        account.turnedOnHere === false ||
        (chosen !== undefined && !chosen.includes(account.id)) ||
        seen.has(account.id)
      )
        continue;
      seen.add(account.id);
      const identity = connectionAccountIdentityLabel(account.metadata ?? {}, "");
      const key = identity
        ? `account\u0000${group.name}\u0000${identity.toLowerCase()}`
        : `connection\u0000${account.id}`;
      const existing = used.find((entry) => entry.key === key);
      if (existing) existing.accounts.push(account);
      else
        used.push({
          key,
          serverId: group.serverId,
          identity,
          connector: group.name,
          label: group.name,
          accounts: [account],
        });
    }
  }
  return used.map(({ key, serverId, accounts, identity, connector }) => ({
    key,
    serverId,
    accounts,
    label:
      identity && used.filter((entry) => entry.connector === connector).length > 1
        ? `${connector} (${identity})`
        : connector,
  }));
}

type Override = { on: boolean; pending: boolean };

/**
 * The owner's quiet line in a chat shared with the workspace (D-54): how many
 * of their own logins work for their messages here ("2 personal connections
 * in this chat"), never which. It opens a menu with one switch per account,
 * the same turn-on and turn-off as the connector's own "Use for my messages
 * here", under one sentence: people here see what the agent does with them.
 * A login turned off stays in the menu while it is open in this chat, so it
 * can go back on. Switches change at once and go back if the change fails.
 * It never blocks anything.
 */
export function OwnLoginsSharedHeadsUp({
  logins,
  onChange,
  logoFor,
  className,
}: {
  /** Your own logins that work for your messages here now (see `ownLoginsInUse`). */
  logins: readonly OwnLoginInUse[];
  /** Turn one account on or off here; reject when it could not. */
  onChange: (login: OwnLoginInUse, on: boolean) => Promise<void>;
  /** The connector's logo, when known. */
  logoFor?: ((login: OwnLoginInUse) => string | null) | undefined;
  className?: string | undefined;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  // Every account seen in this view, in the order first seen, with its first
  // label, so a row keeps its place and name while it is off.
  const seen = useRef(new Map<string, OwnLoginInUse>());
  const current = new Map(logins.map((login) => [login.key, login] as const));
  for (const login of logins) {
    const known = seen.current.get(login.key);
    seen.current.set(login.key, known ? { ...login, label: known.label } : login);
  }
  // A switch turned on settles once the inventory says so too.
  const settled = [...overrides]
    .filter(([key, override]) => !override.pending && override.on && current.has(key))
    .map(([key]) => key)
    .join("\u0000");
  useEffect(() => {
    if (!settled) return;
    setOverrides((previous) => {
      const next = new Map(previous);
      for (const key of settled.split("\u0000")) {
        const override = next.get(key);
        if (override && !override.pending && override.on) next.delete(key);
      }
      return next;
    });
  }, [settled]);
  const rows = [...seen.current.values()].flatMap((login) => {
    const override = overrides.get(login.key);
    if (!current.has(login.key) && !override) return [];
    const on = override ? override.on : true;
    // A login that started on where it was added has no grant to take back here.
    const locked = on && !override && !login.accounts.some(ownLoginCanStopHere);
    return [{ login, on, pending: override?.pending === true, locked }];
  });
  if (rows.length === 0) return null;
  const onCount = rows.filter((row) => row.on).length;
  const toggle = async (login: OwnLoginInUse, on: boolean) => {
    setError(null);
    setOverrides((previous) => new Map(previous).set(login.key, { on, pending: true }));
    try {
      await onChange(login, on);
      setOverrides((previous) => new Map(previous).set(login.key, { on, pending: false }));
    } catch {
      setError(t("ownLogins.couldNotChange"));
      setOverrides((previous) => {
        const next = new Map(previous);
        // Back to where it was: on (from the inventory), or still off in this view.
        if (on) next.set(login.key, { on: false, pending: false });
        else next.delete(login.key);
        return next;
      });
    }
  };
  return (
    <div
      data-testid="own-logins-shared-heads-up"
      className={`flex min-w-0 items-center text-xs text-fg-muted ${className ?? ""}`}
    >
      <DropdownMenu onOpenChange={() => setError(null)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left transition-colors duration-[120ms] hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/55 data-[state=open]:text-fg"
          >
            <InfoIcon aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              {onCount === 0
                ? t("ownLogins.noneInThisChat")
                : t("ownLogins.inThisChat", { count: onCount })}
            </span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={12}
          className="flex max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-24px)] flex-col overflow-y-hidden"
        >
          <DropdownMenuNote className="shrink-0">{t("ownLogins.workspaceSees")}</DropdownMenuNote>
          {error ? (
            <DropdownMenuNote role="alert" className="shrink-0 pt-0 text-danger">
              {error}
            </DropdownMenuNote>
          ) : null}
          <DropdownMenuSeparator className="shrink-0" />
          <DropdownMenuGroup
            data-testid="own-logins-list"
            className="min-h-0 overflow-y-auto overscroll-contain"
          >
            {rows.map(({ login, on, pending, locked }) => (
              <DropdownMenuItem
                key={login.key}
                role="menuitemcheckbox"
                aria-checked={on}
                title={login.label}
                disabled={pending || locked}
                onSelect={(event) => {
                  event.preventDefault();
                  void toggle(login, !on);
                }}
              >
                <CapabilityLogo
                  src={logoFor?.(login) ?? null}
                  name={login.label}
                  size="sm"
                  className="size-5 rounded-md text-[9px] [&_img]:p-0.5"
                />
                <span className="min-w-0 flex-1 truncate">{login.label}</span>
                <ComposerMenuSwitchIndicator checked={on} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
