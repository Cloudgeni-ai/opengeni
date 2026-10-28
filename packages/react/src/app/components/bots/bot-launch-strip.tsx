/**
 * The new-chat composer's note that this chat starts as a bot from a
 * template: who it will be, and a way back to an ordinary chat.
 */
import { XIcon } from "lucide-react";
import type { WorkspaceBotTemplate } from "@opengeni/contracts";

import { Button } from "../../../ui/button";
import { Skeleton } from "../../../ui/skeleton";
import {
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "../session/session-avatar";

export type BotLaunchState =
  | { kind: "loading" }
  | { kind: "ready"; template: WorkspaceBotTemplate }
  | { kind: "error"; message: string };

export function BotLaunchStrip({
  state,
  workspaceId,
  onDismiss,
}: {
  state: BotLaunchState;
  workspaceId: string;
  onDismiss: () => void;
}) {
  return (
    <div
      data-bot-launch=""
      className="flex min-h-9 min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
    >
      {state.kind === "loading" ? (
        <span className="flex min-w-0 flex-1 items-center gap-2" aria-busy="true">
          <Skeleton className="size-5 rounded-[5px]" />
          <Skeleton className="h-3 w-40" />
        </span>
      ) : state.kind === "error" ? (
        <span role="alert" className="min-w-0 flex-1 truncate text-fg-muted">
          Couldn't open the bot template. {state.message}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <SessionAvatar
            avatar={
              state.template.avatar ?? {
                kind: "letters",
                letters: sessionAvatarInitials(state.template.name).slice(0, 2),
                hue: sessionAvatarFallbackHue(state.template.id),
              }
            }
            name={state.template.name}
            workspaceId={workspaceId}
            seed={state.template.id}
            size="sm"
          />
          <span className="min-w-0 truncate">
            <span className="text-fg-muted">New bot: </span>
            <span className="font-medium text-fg">{state.template.name}</span>
            {state.template.description ? (
              <span className="text-fg-muted max-sm:hidden"> · {state.template.description}</span>
            ) : null}
          </span>
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Start an ordinary chat instead"
        title="Start an ordinary chat instead"
        className="shrink-0 text-fg-muted pointer-coarse:size-11"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}
