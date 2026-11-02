import type { ConnectionMetadata } from "@opengeni/sdk";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useRef, useState } from "react";
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
  /** Stable for the account: its connector and its email (or its connection). */
  key: string;
  /** The connector it is used through. */
  serverId: string;
  /** The connector's name. */
  connector: string;
  /** Who it signs in as, when the service says; empty otherwise. */
  identity: string;
  /** Every connection of this account the chat would use (an account can be connected twice). */
  accounts: ConnectionMetadata[];
  /** The connector's name, plus the account when you use more than one account of it. */
  label: string;
};

const EMAIL_KEYS = [
  "email",
  "providerEmail",
  "googleEmail",
  "gmailEmail",
  "googleCalendarEmail",
  "googleDriveEmail",
  "atlassianEmail",
  "linearEmail",
  "notionEmail",
  "asanaEmail",
  "stripeEmail",
  "oidcEmail",
] as const;

/** The account's email, when the service gives one: the only name precise
 * enough to treat two connections as one account. Display names are not. */
function accountEmail(metadata: Record<string, unknown>): string | null {
  for (const key of EMAIL_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && /^[^\s@]+@[^\s@]+$/u.test(value.trim()))
      return value.trim().toLowerCase();
  }
  return null;
}

/** Name each login by its connector, plus the account when one connector has
 * several here; accounts that can't be told apart by name are numbered. */
export function labelOwnLogins<T extends Pick<OwnLoginInUse, "connector" | "identity">>(
  logins: readonly T[],
): (T & { label: string })[] {
  const named = (login: T, same: readonly T[]) =>
    !!login.identity &&
    same.filter((other) => other.identity.toLowerCase() === login.identity.toLowerCase()).length ===
      1;
  return logins.map((login) => {
    const same = logins.filter((other) => other.connector === login.connector);
    if (same.length < 2) return { ...login, label: login.connector };
    if (named(login, same)) return { ...login, label: `${login.connector} (${login.identity})` };
    const unnamed = same.filter((other) => !named(other, same));
    return { ...login, label: `${login.connector} ${unnamed.indexOf(login) + 1}` };
  });
}

/**
 * The viewer's own logins this chat's next message would use: their accounts
 * among the chat's connectors, as chosen (no choice means every eligible
 * account). Each account counts once: connections of one connector that sign
 * in as the same email are one login. Any other connection stays on its own,
 * so different accounts never merge.
 */
export function ownLoginsInUse(
  groups: readonly ConnectedAccountGroup[],
  choices: ConnectionAccountChoices,
  subjectId: string,
): OwnLoginInUse[] {
  const used: Omit<OwnLoginInUse, "label">[] = [];
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
      const email = accountEmail(account.metadata ?? {});
      // The team stays part of the account: one email in two Slack teams is two.
      const key = email
        ? `account\u0000${group.name}\u0000${email}\u0000${identity.toLowerCase()}`
        : `connection\u0000${account.id}`;
      const existing = used.find((entry) => entry.key === key);
      if (existing) existing.accounts.push(account);
      else
        used.push({
          key,
          serverId: group.serverId,
          connector: group.name,
          identity,
          accounts: [account],
        });
    }
  }
  return labelOwnLogins(used);
}

/** A change in flight (`pending`), or done and waiting for the account list
 * to show it: until that list changes (`inventory`), the switch keeps `on`. */
type Override = { on: boolean; pending: boolean; inventory: string };

function inventoryOf(logins: readonly OwnLoginInUse[]): string {
  return JSON.stringify(
    logins.map((login) => [
      login.key,
      login.accounts.map((account) => [account.id, account.turnedOnHereGrantId ?? null]),
    ]),
  );
}

/**
 * The owner's quiet line in a chat shared with the workspace (D-54): how many
 * of their own logins work for their messages here ("2 personal connections
 * in this chat"), never which. It opens a menu with one switch per account,
 * the same turn-on and turn-off as the connector's own "Use for my messages
 * here", under one sentence: people here see what the agent does with them.
 * Whether a switch is on comes from the account list; a change shows at once
 * and the list decides again once it is done or fails. A login turned off in
 * this view stays in the menu, so it can go back on. It never blocks anything.
 */
export function OwnLoginsSharedHeadsUp({
  logins: incoming,
  onChange,
  logoFor,
  className,
}: {
  /** Your own logins that work for your messages here now (see `ownLoginsInUse`);
   * `null` while the list can't be read, which keeps the last one. */
  logins: readonly OwnLoginInUse[] | null;
  /** Turn one account on or off here, and refresh the list; reject when it could not. */
  onChange: (login: OwnLoginInUse, on: boolean) => Promise<void>;
  /** The connector's logo, when known. */
  logoFor?: ((login: OwnLoginInUse) => string | null) | undefined;
  className?: string | undefined;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(() => new Map());
  const [turnedOff, setTurnedOff] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The last list read, and every account seen in this view in the order
  // first seen, so a row keeps its place while it is off. Both only grow or
  // follow `incoming`, so writing them while rendering repeats cleanly.
  const lastRead = useRef<readonly OwnLoginInUse[]>([]);
  if (incoming) lastRead.current = incoming;
  const logins = lastRead.current;
  const seen = useRef(new Map<string, OwnLoginInUse>());
  for (const login of logins) seen.current.set(login.key, login);
  const current = new Map(logins.map((login) => [login.key, login] as const));
  const inventory = inventoryOf(logins);
  // The list as shown now, for a change that finishes later.
  const latestInventory = useRef(inventory);
  latestInventory.current = inventory;
  // A new list settles every change that is done: from here on it decides.
  const [lastInventory, setLastInventory] = useState(inventory);
  if (lastInventory !== inventory) {
    setLastInventory(inventory);
    setOverrides((previous) => new Map([...previous].filter(([, override]) => override.pending)));
  }
  const effective = (key: string): Override | undefined => {
    const override = overrides.get(key);
    return override && (override.pending || override.inventory === inventory)
      ? override
      : undefined;
  };
  const visible = [...seen.current.values()].filter(
    (login) => current.has(login.key) || turnedOff.has(login.key) || effective(login.key),
  );
  const rows = labelOwnLogins(visible).map((login) => {
    const override = effective(login.key);
    const on = override ? override.on : current.has(login.key);
    const listed = current.get(login.key);
    return {
      // As the list has it now; an account off here keeps its last copy.
      login,
      on,
      // Done but not yet in the list: nothing up to date to act on, unless
      // the list can't be read now, which may not change soon.
      busy:
        override !== undefined &&
        (override.pending || (incoming !== null && override.on !== Boolean(listed))),
      // On without a standing grant here for every connection, so it can't
      // be turned off from here (only from where it was added).
      locked: on && !override && !!listed && !listed.accounts.every(ownLoginCanStopHere),
    };
  });
  if (rows.length === 0) return null;
  const onCount = rows.filter((row) => row.on).length;
  const toggle = async (login: OwnLoginInUse, on: boolean) => {
    setError(null);
    if (!on) setTurnedOff((previous) => new Set(previous).add(login.key));
    setOverrides((previous) =>
      new Map(previous).set(login.key, { on, pending: true, inventory: "" }),
    );
    try {
      await onChange(login, on);
      setOverrides((previous) => {
        const next = new Map(previous);
        const override = next.get(login.key);
        if (override?.pending) {
          next.set(login.key, {
            ...override,
            pending: false,
            inventory: latestInventory.current,
          });
        }
        return next;
      });
    } catch {
      setError(t("ownLogins.couldNotChange"));
      // The list decides again: on stays on, partly on shows on, off stays off.
      setOverrides((previous) => {
        const next = new Map(previous);
        next.delete(login.key);
        return next;
      });
    }
  };
  return (
    <div
      data-testid="own-logins-shared-heads-up"
      className={`flex min-w-0 items-center gap-2 text-xs text-fg-muted ${className ?? ""}`}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Read in the menu: closing it puts the line back to just the count.
          if (!next) setError(null);
        }}
      >
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
            {rows.map(({ login, on, busy, locked }) => (
              <DropdownMenuItem
                key={login.key}
                role="menuitemcheckbox"
                aria-checked={on}
                title={login.label}
                disabled={busy || locked}
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
      {error && !open ? (
        <span role="alert" className="min-w-0 shrink truncate text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
