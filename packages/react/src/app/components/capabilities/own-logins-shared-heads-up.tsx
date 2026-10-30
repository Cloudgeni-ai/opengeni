import type { ConnectionMetadata } from "@opengeni/sdk";
import { InfoIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../ui/button";
import { t } from "../../lib/console-text";
import { connectionAccountLabel } from "./connection-account-picker";
import { ownLoginCanStopHere } from "./own-login-turned-on";
import type {
  ConnectedAccountGroup,
  ConnectionAccountChoices,
} from "./session-connection-accounts";

export type OwnLoginInUse = { account: ConnectionMetadata; label: string };

/**
 * The viewer's own logins this chat's next message would use: their accounts
 * among the chat's connectors, as chosen (no choice means every eligible
 * account). Each is named by its connector, plus the account when they have
 * more than one for it.
 */
export function ownLoginsInUse(
  groups: readonly ConnectedAccountGroup[],
  choices: ConnectionAccountChoices,
  subjectId: string,
): OwnLoginInUse[] {
  const used: OwnLoginInUse[] = [];
  for (const group of groups) {
    const chosen = choices[group.serverId];
    const own = group.accounts.filter(
      (account) =>
        account.subjectId === subjectId &&
        account.turnedOnHere !== false &&
        (chosen === undefined || chosen.includes(account.id)),
    );
    for (const account of own) {
      if (used.some((entry) => entry.account.id === account.id)) continue;
      used.push({
        account,
        label:
          own.length > 1
            ? `${group.name} (${connectionAccountLabel(account, group.name)})`
            : group.name,
      });
    }
  }
  return used;
}

function namesList(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(t.locale, { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/**
 * The owner's one-line heads-up in a chat shared with the workspace (D-54):
 * their own logins work for their messages here, and people here see what the
 * agent does with them. It never blocks anything; each login can be stopped
 * here.
 */
export function OwnLoginsSharedHeadsUp({
  logins,
  onStop,
  className,
}: {
  logins: readonly OwnLoginInUse[];
  onStop: (account: ConnectionMetadata) => Promise<void>;
  className?: string | undefined;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (logins.length === 0) return null;
  const names = namesList(logins.map((login) => login.label));
  const stoppable = logins.filter((login) => ownLoginCanStopHere(login.account));
  const stop = async (account: ConnectionMetadata) => {
    setStopping(account.id);
    setError(null);
    try {
      await onStop(account);
    } catch {
      setError(t("ownLogins.couldNotStop"));
    } finally {
      setStopping(null);
    }
  };
  return (
    <div
      data-testid="own-logins-shared-heads-up"
      className={`flex min-w-0 items-start gap-1.5 text-xs text-fg-muted ${className ?? ""}`}
    >
      <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">
        {t("ownLogins.sharedHeadsUp", { count: logins.length, logins: names })}
        {stoppable.map((login) => (
          <span key={login.account.id}>
            {" "}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 align-baseline"
              disabled={stopping !== null}
              onClick={() => void stop(login.account)}
            >
              {stoppable.length === 1
                ? t("ownLogins.stopUsingHere")
                : t("ownLogins.stopUsingLoginHere", { login: login.label })}
            </Button>
          </span>
        ))}
        {error ? (
          <span role="alert" className="text-destructive">
            {" "}
            {error}
          </span>
        ) : null}
      </span>
    </div>
  );
}
