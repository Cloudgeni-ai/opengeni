import type { AgentProfile, Session, SessionAgentProfile } from "@opengeni/sdk";
import {
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";

import { AgentMark } from "../../ui/agent-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { userErrorText } from "../../ui/api-error";
import { useAppContext } from "../app-context";
import { useAppAgentProfiles } from "../lib/agent-profiles";
import { useNavigate } from "../lib/navigation";
import { toast } from "../lib/toast";
import { cn } from "../lib/utils";

/* ----------------------------------------------------------------------------
   The agent chip beside the model picker (Option A). On a new chat it chooses
   the saved agent the chat starts from; on a running chat it switches the
   chat's agent from the next message. Picking an agent fills its model, tools
   and instructions through the ordinary session settings.
   -------------------------------------------------------------------------- */

export type ComposerAgentChipProps = {
  profiles: readonly AgentProfile[];
  /** The selected saved agent (new chat), or null for the default agent. */
  selectedProfileId: string | null;
  /** What a running chat wears now, shown on the chip; overrides the selection display. */
  wearing?: SessionAgentProfile | null | undefined;
  /** New chat: null selects the default agent. Running chat: switch. */
  onSelect: (profile: AgentProfile | null) => void;
  /** Offer "Opengeni (default)". Running chats cannot un-apply a profile's settings. */
  allowDefault: boolean;
  onManage: () => void;
  onNewAgent: () => void;
  /** Running chat only: save how this chat works as a reusable agent. */
  onSaveChatAsAgent?: (() => void) | undefined;
  disabled?: boolean | undefined;
};

export function ComposerAgentChip(props: ComposerAgentChipProps) {
  const selected = props.profiles.find((profile) => profile.id === props.selectedProfileId) ?? null;
  const shown =
    props.wearing ?? (selected ? { name: selected.name, avatar: selected.avatar } : null);
  const label = shown ? shown.name : "Opengeni";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={props.disabled}>
        <button
          type="button"
          aria-label={`Agent: ${label}. Switch agent`}
          title={`Agent: ${label}`}
          className={cn(
            "relative inline-flex h-8 min-w-8 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors duration-[120ms]",
            "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            shown
              ? "bg-surface-2 text-fg hover:bg-surface-3"
              : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
        >
          <AgentMark avatar={shown?.avatar ?? null} size={18} />
          <span className="truncate max-sm:hidden">{label}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <DropdownMenuLabel>
          {props.allowDefault ? "Agent for this chat" : "Switch agent"}
        </DropdownMenuLabel>
        {props.allowDefault ? (
          <AgentMenuItem
            name="Opengeni"
            detail="Default, your workspace settings"
            avatar={null}
            checked={!selected}
            onSelect={() => props.onSelect(null)}
          />
        ) : null}
        {props.profiles.map((profile) => (
          <AgentMenuItem
            key={profile.id}
            name={profile.name}
            detail={
              [profile.role, profile.config.model].filter(Boolean).join(" · ") || "Saved agent"
            }
            avatar={profile.avatar}
            checked={
              props.wearing
                ? props.wearing.profileId === profile.id
                : props.selectedProfileId === profile.id
            }
            onSelect={() => props.onSelect(profile)}
          />
        ))}
        {props.profiles.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-fg-subtle">
            No saved agents yet. Save one to reuse its instructions and settings.
          </p>
        ) : null}
        <DropdownMenuSeparator />
        {props.onSaveChatAsAgent ? (
          <DropdownMenuItem onSelect={props.onSaveChatAsAgent}>
            <BookmarkPlusIcon aria-hidden="true" />
            Save this chat as an agent…
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={props.onNewAgent}>
            <PlusIcon aria-hidden="true" />
            New agent…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={props.onManage}>
          <Settings2Icon aria-hidden="true" />
          Manage agents
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentMenuItem(props: {
  name: string;
  detail: string;
  avatar: AgentProfile["avatar"] | null;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={props.onSelect} className="items-center gap-2.5 py-1.5">
      <AgentMark avatar={props.avatar} size={24} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-fg">{props.name}</span>
        <span className="truncate text-2xs text-fg-subtle">{props.detail}</span>
      </span>
      {props.checked ? <CheckIcon aria-hidden="true" className="size-4 text-fg" /> : null}
    </DropdownMenuItem>
  );
}

/**
 * The agent chip on a running chat's composer. Switching applies the saved
 * agent's settings from the next message (same concurrency check as editing
 * the chat's agent settings) and the chat then wears its identity.
 */
export function RunningChatAgentChip(props: { session: Session; disabled?: boolean | undefined }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const profiles = useAppAgentProfiles();
  if (!profiles.enabled) return null;
  const { session } = props;
  const toAgents = (path: "" | "/new", search?: Record<string, string>) =>
    void navigate({
      to: `/workspaces/$workspaceId/agents${path}`,
      params: { workspaceId: session.workspaceId },
      ...(search ? { search } : {}),
    });
  return (
    <ComposerAgentChip
      profiles={profiles.profiles}
      selectedProfileId={session.agentProfile?.profileId ?? null}
      wearing={session.agentProfile ?? null}
      allowDefault={false}
      disabled={props.disabled || profiles.mutating}
      onSelect={(profile) => {
        if (!profile || profile.id === session.agentProfile?.profileId) return;
        void (async () => {
          const updated = await profiles.applyToSession(
            session.id,
            profile.id,
            session.toolPolicyVersion ?? 1,
          );
          if (!updated) {
            toast.error(`Couldn't switch to ${profile.name}`, {
              description: profiles.mutationError
                ? userErrorText(profiles.mutationError)
                : "The chat's settings changed. Try again.",
            });
            return;
          }
          context.adoptUpdatedSession?.(updated);
          toast.success(`${profile.name} takes over from your next message`);
        })();
      }}
      onManage={() => toAgents("")}
      onNewAgent={() => toAgents("/new")}
      onSaveChatAsAgent={() => toAgents("/new", { fromSession: session.id })}
    />
  );
}
