/**
 * The new chat's agent chip, first in the setup strip: "Opengeni ▾", or the
 * agent this chat starts with. Its menu lists the agents to chat with and
 * ends with Browse agents. Picking one puts `?agent=<id>` in the URL, so the
 * choice survives a reload and can be linked.
 */
import { ChevronDownIcon, LayoutGridIcon } from "lucide-react";
import type { AgentSummary, SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";

import { Button } from "../../../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { Skeleton } from "../../../ui/skeleton";
import { agentAvatar } from "../../lib/agent-avatar";
import { cn } from "../../lib/utils";
import { BrandMark } from "../brand-mark";
import { SessionAvatar } from "../session/session-avatar";

/** The agent a new chat starts with, as the chip shows it. */
export type ComposerAgentSelection =
  | { kind: "loading"; id: string }
  | { kind: "ready"; id: string; name: string; avatar: SessionAvatarValue }
  | { kind: "error"; id: string; message: string };

/** How many agents the menu lists; Browse agents opens the rest. */
const LISTED = 8;

export function ComposerAgentChip({
  workspaceId,
  agents,
  selection,
  disabled,
  onSelect,
  onBrowse,
  className,
}: {
  workspaceId: string;
  /** The agents the reader can chat with; undefined while they load. */
  agents: AgentSummary[] | undefined;
  /** Null: Opengeni itself. */
  selection: ComposerAgentSelection | null;
  disabled: boolean;
  onSelect: (agentId: string | null) => void;
  onBrowse: () => void;
  className?: string | undefined;
}) {
  const selectedId = selection?.id ?? null;
  const listed = (agents ?? []).slice(0, LISTED);
  // The chosen agent stays in the list even when it isn't among the first few.
  const chosen =
    selectedId && !listed.some((agent) => agent.id === selectedId)
      ? (agents ?? []).find((agent) => agent.id === selectedId)
      : undefined;
  const rows = chosen ? [chosen, ...listed] : listed;
  const label =
    selection === null
      ? "Opengeni"
      : selection.kind === "ready"
        ? selection.name
        : selection.kind === "error"
          ? "Agent unavailable"
          : "Agent";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Chat with: ${label}`}
          title={selection?.kind === "error" ? selection.message : "Chat with"}
          data-composer-agent=""
          className={cn(
            "h-8 min-w-0 max-w-[14rem] shrink gap-1.5 overflow-hidden rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
            selection !== null && "border-border bg-surface text-fg",
            className,
          )}
        >
          {selection === null ? (
            <BrandMark className="w-3.5" />
          ) : selection.kind === "ready" ? (
            <SessionAvatar
              avatar={selection.avatar}
              name={selection.name}
              workspaceId={workspaceId}
              seed={selection.id}
              size="xs"
            />
          ) : selection.kind === "loading" ? (
            <Skeleton className="size-4 rounded-[4px]" />
          ) : null}
          <span className="min-w-0 truncate">
            {selection?.kind === "loading" ? <Skeleton className="h-3 w-16" /> : label}
          </span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-72">
        <DropdownMenuLabel>Chat with</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <BrandMark className="w-4" />
          <span className="min-w-0 flex-1 truncate">Opengeni</span>
          <DropdownMenuCheck checked={selectedId === null} />
        </DropdownMenuItem>
        {agents === undefined ? (
          <div className="flex items-center gap-2 px-2 py-1.5" aria-busy="true">
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="h-3 w-32" />
          </div>
        ) : (
          rows.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onSelect(agent.id)}
              title={agent.description || undefined}
            >
              <SessionAvatar
                avatar={agentAvatar(agent)}
                name={agent.name}
                workspaceId={workspaceId}
                seed={agent.id}
                size="xs"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{agent.name}</span>
                {agent.description ? (
                  <span className="block truncate text-xs text-fg-muted">{agent.description}</span>
                ) : null}
              </span>
              <DropdownMenuCheck checked={selectedId === agent.id} />
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onBrowse}>
          <LayoutGridIcon />
          Browse agents
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
