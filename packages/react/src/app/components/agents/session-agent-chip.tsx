/**
 * The chat header's agent chip: the agent's icon and name, opening the
 * agent's page. Eager (the header loads with every chat): no zod here.
 */
import { Link } from "../../lib/navigation";
import type { SessionAgentInfo } from "../../lib/session-agent";
import { cn } from "../../lib/utils";
import { SessionAvatar } from "../session/session-avatar";

export function SessionAgentChip({
  agent,
  workspaceId,
  className,
}: {
  agent: SessionAgentInfo;
  workspaceId: string;
  className?: string | undefined;
}) {
  const content = (
    <>
      <SessionAvatar
        avatar={agent.avatar}
        name={agent.name}
        workspaceId={workspaceId}
        seed={agent.id}
        size="xs"
      />
      <span data-session-agent="" className="min-w-0 truncate">
        {agent.name}
      </span>
    </>
  );
  const chipClass = cn(
    "inline-flex h-6 max-w-48 min-w-0 items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-fg-label",
    className,
  );
  // An agent that is gone (or that the reader can't open) still names itself, without a link.
  if (!agent.live) {
    return (
      <span className={chipClass} title={agent.name}>
        {content}
      </span>
    );
  }
  return (
    <Link
      to="/workspaces/$workspaceId/agents/$agentId"
      params={{ workspaceId, agentId: agent.id }}
      title={`Open ${agent.name}`}
      className={cn(
        chipClass,
        "outline-hidden transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-11",
      )}
    >
      {content}
    </Link>
  );
}
