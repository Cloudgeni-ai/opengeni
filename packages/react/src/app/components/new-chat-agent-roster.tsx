import type { AgentProfile } from "@opengeni/sdk";
import { PlusIcon } from "lucide-react";

import { AgentMark } from "../../ui/agent-mark";
import { cn } from "../lib/utils";

const ROSTER_LIMIT = 4;

/**
 * "Who should take this on?" (Option B): the workspace's saved agents as cards
 * above the new-chat composer. Picking one selects it in the composer's agent
 * chip; picking it again returns to the default agent.
 */
export function NewChatAgentRoster(props: {
  profiles: readonly AgentProfile[];
  selectedProfileId: string | null;
  onSelect: (profile: AgentProfile | null) => void;
  onNewAgent: () => void;
}) {
  const shown = props.profiles.slice(0, ROSTER_LIMIT);
  return (
    <section aria-label="Start with an agent" className="mt-6">
      <h2 className="mb-2 text-xs font-medium text-fg-muted">Start with an agent</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {shown.map((profile) => {
          const selected = profile.id === props.selectedProfileId;
          return (
            <button
              key={profile.id}
              type="button"
              aria-pressed={selected}
              onClick={() => props.onSelect(selected ? null : profile)}
              className={cn(
                "flex min-h-28 flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors",
                "outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40",
                selected
                  ? "border-border-strong bg-surface-2"
                  : "border-border bg-surface hover:bg-hover",
              )}
            >
              <AgentMark avatar={profile.avatar} size={28} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-fg">{profile.name}</span>
                {profile.role ? (
                  <span className="line-clamp-2 text-2xs text-fg-subtle">{profile.role}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={props.onNewAgent}
          className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong p-3 text-xs text-fg-muted transition-colors outline-hidden hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          New agent
        </button>
      </div>
    </section>
  );
}
