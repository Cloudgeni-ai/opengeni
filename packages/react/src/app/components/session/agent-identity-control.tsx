import type { AgentAvatar, Session } from "@opengeni/sdk";
import { Popover } from "radix-ui";
import { useEffect, useId, useState } from "react";
import { toast } from "../../lib/toast";

import { AgentAvatarPicker } from "../../../ui/agent-avatar-picker";
import { AgentMark, agentAvatarHueForName } from "../../../ui/agent-mark";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { MENU_SURFACE_CLASS } from "../../../ui/menu-styles";
import { containedPortal } from "../../../ui/portal-container";
import { useAppContext } from "../../app-context";
import { useAgentProfilesEnabled, useAppAgentProfiles } from "../../lib/agent-profiles";
import { useNavigate } from "../../lib/navigation";
import { cn } from "../../lib/utils";

const PopoverContainedPortal = containedPortal(Popover.Portal);

const TITLE_EMOJI_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(review|pr|pull request)/i, "🦉"],
  [/\b(bug|fix|flaky|test|failing)/i, "🐞"],
  [/\b(mail|inbox|email|gmail)/i, "📬"],
  [/\b(deploy|rollout|release|incident|watch)/i, "🛰️"],
  [/\b(kpi|metric|report|digest|dashboard)/i, "📈"],
  [/\b(write|changelog|docs?|blog|post|copy)/i, "✍️"],
  [/\b(invoice|receipt|expense|billing)/i, "🧾"],
  [/\b(research|search|find|prospect)/i, "🔎"],
  [/\b(plan|roadmap|strategy)/i, "🧭"],
];

/** A first suggestion so naming a chat's agent can be one click. */
export function suggestedAgentAvatar(title: string, name: string): AgentAvatar {
  const emoji = TITLE_EMOJI_HINTS.find(([pattern]) => pattern.test(title))?.[1] ?? "🤖";
  return { kind: "emoji", emoji, hue: agentAvatarHueForName(name || title || "agent") };
}

/**
 * The agent tile in the chat header (Level 1, "Name it"). It shows the
 * identity this chat's agent wears, or the default Opengeni mark. Clicking it
 * names only this chat's agent; saving a reusable agent is one step further.
 */
export function AgentIdentityControl({ session }: { session: Session }) {
  // Hosts without the feature (or without navigation) never reach the hooks below.
  const enabled = useAgentProfilesEnabled();
  if (!enabled) return null;
  return <AgentIdentityControlEnabled session={session} />;
}

function AgentIdentityControlEnabled({ session }: { session: Session }) {
  const id = useId();
  const context = useAppContext();
  const navigate = useNavigate();
  const profiles = useAppAgentProfiles();
  const identity = session.agentProfile ?? null;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(identity?.name ?? "");
  const [avatar, setAvatar] = useState<AgentAvatar>(
    identity?.avatar ?? suggestedAgentAvatar(session.title ?? "", ""),
  );

  useEffect(() => {
    if (!open) return;
    setName(identity?.name ?? "");
    setAvatar(identity?.avatar ?? suggestedAgentAvatar(session.title ?? "", ""));
    // Reset the draft each time the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!profiles.enabled) return null;

  const save = async (next: { name: string; avatar: AgentAvatar } | null) => {
    const updated = await profiles.setSessionIdentity(session.id, next);
    if (!updated) {
      toast.error("Couldn't name this agent", {
        description: profiles.mutationError ? userErrorText(profiles.mutationError) : undefined,
      });
      return;
    }
    context.adoptUpdatedSession?.(updated);
    setOpen(false);
  };

  const trimmed = name.trim();
  const triggerLabel = identity
    ? `Agent: ${identity.name}. Rename or change avatar`
    : "Name this chat's agent";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={identity ? (identity.role ?? identity.name) : "Name this chat's agent"}
          className={cn(
            "inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-semibold text-fg",
            "outline-hidden hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40",
          )}
        >
          <AgentMark avatar={identity?.avatar ?? null} size={identity ? 22 : 20} />
          {identity ? (
            <>
              <span className="max-w-40 truncate">{identity.name}</span>
              <span aria-hidden="true" className="font-normal text-fg-subtle">
                /
              </span>
            </>
          ) : null}
        </button>
      </Popover.Trigger>
      <PopoverContainedPortal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Name this chat's agent"
          className={cn(
            MENU_SURFACE_CLASS,
            "z-50 flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-4 p-4 outline-hidden",
          )}
        >
          <div className="flex items-center gap-3">
            <AgentMark avatar={avatar} size={48} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={`${id}-name`} className="text-2xs text-fg-muted">
                Name
              </label>
              <Input
                id={`${id}-name`}
                suppressAutofill
                autoFocus
                maxLength={60}
                placeholder="e.g. Deploy watcher"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && trimmed) void save({ name: trimmed, avatar });
                }}
              />
            </div>
          </div>
          <AgentAvatarPicker value={avatar} onChange={setAvatar} name={trimmed} />
          <p className="text-xs text-fg-subtle">
            {identity?.profileId
              ? `This chat uses the saved agent ${identity.name}. Changes here rename only this chat's agent.`
              : "Only this chat. The agent keeps its current settings; nothing else changes."}
          </p>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                void navigate({
                  to: "/workspaces/$workspaceId/agents/new",
                  params: { workspaceId: session.workspaceId },
                  search: { fromSession: session.id },
                });
              }}
            >
              Save as reusable agent
            </Button>
            {identity ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={profiles.mutating}
                onClick={() => void save(null)}
              >
                Remove
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={!trimmed || profiles.mutating}
              onClick={() => void save({ name: trimmed, avatar })}
            >
              Done
            </Button>
          </div>
        </Popover.Content>
      </PopoverContainedPortal>
    </Popover.Root>
  );
}
