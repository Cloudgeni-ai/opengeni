/**
 * Under the new-chat composer: the workspace's bot templates, one tap to start
 * a bot from each, and the page with all of them. Shows nothing until the
 * workspace has one, so ordinary new chats look as they always have.
 */
import { ChevronRightIcon } from "lucide-react";
import type { WorkspaceBotTemplate } from "@opengeni/contracts";

import { Link } from "../../lib/navigation";
import { cn } from "../../lib/utils";
import {
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "../session/session-avatar";

const SHOWN = 4;

export function BotTemplateShortcuts({
  workspaceId,
  templates,
  disabled,
  className,
}: {
  workspaceId: string;
  /** The workspace's templates; undefined while they load. */
  templates: WorkspaceBotTemplate[] | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  if (!templates || templates.length === 0) return null;
  return (
    <nav
      aria-label="Start a bot"
      className={cn("mt-4 flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      <span className="mr-1 text-xs text-fg-muted">Start a bot</span>
      {templates.slice(0, SHOWN).map((template) => (
        <Link
          key={template.id}
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId }}
          search={{ botTemplateId: template.id }}
          aria-disabled={disabled || undefined}
          title={template.description || template.name}
          className={cn(
            "inline-flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-full border border-border bg-surface px-1 pr-2.5 text-xs text-fg-label outline-hidden transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-11",
            disabled && "pointer-events-none opacity-60",
          )}
        >
          <SessionAvatar
            avatar={
              template.avatar ?? {
                kind: "letters",
                letters: sessionAvatarInitials(template.name).slice(0, 2),
                hue: sessionAvatarFallbackHue(template.id),
              }
            }
            name={template.name}
            workspaceId={workspaceId}
            seed={template.id}
            size="sm"
          />
          <span className="min-w-0 truncate">{template.name}</span>
        </Link>
      ))}
      <Link
        to="/workspaces/$workspaceId/bot-templates"
        params={{ workspaceId }}
        className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs text-fg-muted outline-hidden hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-11"
      >
        {templates.length > SHOWN ? `All ${templates.length}` : "Manage"}
        <ChevronRightIcon className="size-3" />
      </Link>
    </nav>
  );
}
