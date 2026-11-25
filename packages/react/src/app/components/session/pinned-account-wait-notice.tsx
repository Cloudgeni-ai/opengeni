import { CircleAlertIcon } from "lucide-react";
import type { SessionEvent, SessionModelAccountChoiceResponse } from "@opengeni/sdk";

import {
  useSessionModelAccount,
  type ModelAccountClientLike,
} from "../../../hooks/use-session-model-account";
import { Button } from "../../../ui/button";
import { codexUsageResetText } from "../../lib/codex-model-switch";
import type { PinnedAccountWait } from "../../lib/pinned-account-wait";
import { subscriptionProviderPresentation } from "../../lib/subscription-provider";

/** What the notice says, decided from the wait and the chat's account choice. */
export type PinnedAccountWaitCopy = {
  /** "This chat is pinned to the Claude account “Team”, which is out of capacity." */
  headline: string;
  /** "Resets Sat 18:00." for an account out of capacity; null otherwise. */
  resetText: string | null;
};

export function pinnedAccountWaitCopy(
  wait: PinnedAccountWait,
  choice: SessionModelAccountChoiceResponse | null,
  options: { now?: Date; locale?: string; timeZone?: string } = {},
): PinnedAccountWaitCopy {
  const { name } = subscriptionProviderPresentation(wait.provider);
  const binding =
    choice?.bindings?.find((each) => each.provider === wait.provider) ??
    (choice?.binding?.provider === wait.provider ? choice.binding : null);
  const pinnedId = binding?.choice === "explicit" ? binding.connectionId : null;
  const account = pinnedId
    ? (choice?.accounts.find(
        (each) => each.provider === wait.provider && each.connectionId === pinnedId,
      ) ?? null)
    : null;
  const label = account?.label?.trim() || account?.accountEmail?.trim() || null;
  const pinnedTo = label ? `the ${name} account “${label}”` : `one ${name} account`;
  const state =
    wait.reason === "pinned_account_disabled"
      ? "which is turned off"
      : wait.reason === "pinned_account_ineligible"
        ? "which can no longer serve this chat"
        : "which is out of capacity";
  const resetsAt =
    wait.reason === "pinned_account_unavailable"
      ? (wait.resetsAt ?? account?.usage?.exhaustedUntil ?? null)
      : null;
  return {
    headline: `This chat is pinned to ${pinnedTo}, ${state}.`,
    resetText:
      wait.reason === "pinned_account_unavailable" ? codexUsageResetText(resetsAt, options) : null,
  };
}

/**
 * Composer notice while the chat's turn waits on the account a person pinned
 * it to. The pin is honoured, never overridden: the notice names the account
 * and when it has room again, and offers the one change that lets the turn
 * continue elsewhere now, switching the chat back to automatic account choice.
 * A model switch is not offered: the pin holds whatever the model.
 */
export function PinnedAccountWaitNotice({
  workspaceId,
  sessionId,
  wait,
  events,
  canChoose,
  modelAccountClient,
}: {
  workspaceId: string;
  sessionId: string;
  wait: PinnedAccountWait;
  events?: SessionEvent[] | undefined;
  /** The person may change this chat's account (`sessions:control`). */
  canChoose: boolean;
  modelAccountClient?: ModelAccountClientLike | undefined;
}) {
  const account = useSessionModelAccount({
    workspaceId,
    sessionId,
    provider: wait.provider,
    ...(events !== undefined ? { events } : {}),
    ...(modelAccountClient ? { modelAccountClient } : {}),
  });
  const copy = pinnedAccountWaitCopy(wait, account.choice);
  const switched = account.appliedTo !== null && !account.choosing;
  return (
    <div
      role="status"
      data-testid="pinned-account-wait-notice"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 text-fg-muted">
        <span className="font-medium text-fg">{copy.headline}</span>
        {copy.resetText ? ` ${copy.resetText}` : ""}{" "}
        {switched
          ? "Switched to automatic account choice; the waiting turn continues on another account."
          : canChoose
            ? "Automatic account choice continues it on another account now."
            : "Someone who can manage this chat can switch it to automatic account choice."}
      </p>
      {canChoose && !switched ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={account.choosing}
          aria-busy={account.choosing || undefined}
          data-testid="pinned-account-wait-automatic"
          onClick={() => void account.choose(null)}
        >
          {account.choosing ? "Switching…" : "Use automatic account choice"}
        </Button>
      ) : null}
      {account.mutationError ? (
        <p role="alert" className="basis-full text-xs text-fg-muted">
          {account.mutationError.message}
        </p>
      ) : null}
    </div>
  );
}
