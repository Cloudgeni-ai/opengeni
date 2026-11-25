import { CircleAlertIcon } from "lucide-react";
import type { SessionEvent } from "@opengeni/sdk";

import {
  useSessionModelAccount,
  type ModelAccountClientLike,
} from "../../../hooks/use-session-model-account";
import { Button } from "../../../ui/button";
import { ownAccountWithRoom } from "../../lib/own-account-wait";

/**
 * Composer notice while a turn someone else started (for example meeting
 * notes) waits for Codex usage, and the viewer's own ChatGPT account has
 * room. Their own subscription serves only turns they send (D-53), so the
 * notice says why it is not used and offers the one action that uses it:
 * continuing the chat themselves. Renders nothing without such an account.
 */
export function OwnAccountWaitNotice({
  workspaceId,
  sessionId,
  model,
  events,
  pending = false,
  error,
  onContinue,
  modelAccountClient,
}: {
  workspaceId: string;
  sessionId: string;
  /** The chat's model, which the viewer's account must be allowed to serve. */
  model: string;
  events?: SessionEvent[] | undefined;
  pending?: boolean | undefined;
  error?: string | null | undefined;
  /** Sends "Continue" as the viewer, taking over the waiting turn. */
  onContinue: () => void;
  modelAccountClient?: ModelAccountClientLike | undefined;
}) {
  const account = useSessionModelAccount({
    workspaceId,
    sessionId,
    provider: "codex",
    ...(events !== undefined ? { events } : {}),
    ...(modelAccountClient ? { modelAccountClient } : {}),
  });
  if (!ownAccountWithRoom(account.choice, { provider: "codex", model })) return null;
  return (
    <div
      role="status"
      data-testid="own-account-wait-notice"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 text-fg-muted">
        <span className="font-medium text-fg">
          This chat started automatically, so it can’t use your own ChatGPT account.
        </span>
      </p>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        aria-busy={pending || undefined}
        data-testid="own-account-wait-continue"
        onClick={onContinue}
      >
        {pending ? "Continuing…" : "Continue on my account"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-fg-muted">
          {error}
        </p>
      ) : null}
    </div>
  );
}
