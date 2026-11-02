import type { ConnectionMetadata } from "@opengeni/sdk";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { t } from "../../lib/console-text";
import { ownLoginCanStopHere } from "./own-login-turned-on";
import type {
  ConnectedAccountGroup,
  ConnectionAccountChoices,
} from "./session-connection-accounts";

/** One of your own accounts this chat uses, however many times it is connected. */
export type OwnLoginInUse = {
  /** Every connection of this account the chat would use (an account can be connected twice). */
  accounts: ConnectionMetadata[];
  /** The connector's name, plus the account when you use more than one account of it. */
  label: string;
  /** The connector's name alone. */
  connector: string;
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
  const used: (OwnLoginInUse & { key: string; identity: string })[] = [];
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
        used.push({ key, identity, connector: group.name, label: group.name, accounts: [account] });
    }
  }
  return used.map(({ key: _key, identity, ...login }) => ({
    ...login,
    label:
      identity && used.filter((entry) => entry.connector === login.connector).length > 1
        ? `${login.connector} (${identity})`
        : login.connector,
  }));
}

function namesList(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(t.locale, { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/**
 * The owner's quiet line in a chat shared with the workspace (D-54): which of
 * their own logins this chat uses. It opens a menu that says the rest once
 * (they work for the owner's messages, and people here see what the agent
 * does with them) and stops each login here. It never blocks anything.
 */
export function OwnLoginsSharedHeadsUp({
  logins,
  onStop,
  className,
}: {
  logins: readonly OwnLoginInUse[];
  /** Turn these connections (one account's) off here. */
  onStop: (accounts: readonly ConnectionMetadata[]) => Promise<void>;
  className?: string | undefined;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (logins.length === 0) return null;
  const summary = t("ownLogins.usingYour", {
    logins: namesList([...new Set(logins.map((login) => login.connector))]),
  });
  const stoppable = logins.filter((login) => login.accounts.some(ownLoginCanStopHere));
  const stop = async (login: OwnLoginInUse) => {
    setStopping(true);
    setError(null);
    try {
      await onStop(login.accounts.filter(ownLoginCanStopHere));
    } catch {
      setError(t("ownLogins.couldNotStop"));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div
      data-testid="own-logins-shared-heads-up"
      className={`flex min-w-0 items-center gap-2 text-xs text-fg-muted ${className ?? ""}`}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={summary}
            className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left transition-colors duration-[120ms] hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/55 data-[state=open]:text-fg"
          >
            <InfoIcon aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{summary}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={12}
          className="w-72 max-w-[calc(100vw-24px)]"
        >
          <DropdownMenuNote>
            {t("ownLogins.sharedDetails", { count: logins.length })}
          </DropdownMenuNote>
          {stoppable.length > 0 ? <DropdownMenuSeparator /> : null}
          {stoppable.map((login) => (
            <DropdownMenuItem
              key={login.accounts[0]!.id}
              disabled={stopping}
              onSelect={() => void stop(login)}
            >
              <span className="min-w-0 truncate">
                {t("ownLogins.stopUsingLoginHere", { login: login.label })}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <span role="alert" className="shrink-0 text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
