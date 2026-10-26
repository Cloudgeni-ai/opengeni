import type { AgentProfile } from "@opengeni/sdk";

import { AgentMark } from "../../ui/agent-mark";
import { MENU_SURFACE_CLASS } from "../../ui/menu-styles";
import type { ComposerState } from "../../hooks/use-composer";
import { cn } from "../lib/utils";

/* ----------------------------------------------------------------------------
   @mention a saved agent (Option C). Typing "@" at the end of the message
   offers the workspace's agents; picking one writes "@Name". When the message
   is sent, every mentioned agent's id rides along as message context, so the
   chat's agent can hand the work to it as a child session started from that
   agent (session_create with agentProfileId). The mention grants nothing: the
   child still resolves inside this chat's own authority.
   -------------------------------------------------------------------------- */

const TRAILING_MENTION = /(^|\s)@([\p{L}\p{N}_.-]{0,40})$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Saved agents the text mentions as "@Name", in order of first mention. */
export function mentionedAgentProfiles(
  text: string,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  const found: Array<{ at: number; profile: AgentProfile }> = [];
  for (const profile of profiles) {
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])@${escapeRegExp(profile.name)}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    const match = pattern.exec(text);
    if (match) found.push({ at: match.index, profile });
  }
  return found.sort((left, right) => left.at - right.at).map((entry) => entry.profile);
}

/** The message context naming each mentioned agent, or undefined when none is mentioned. */
export function agentMentionContext(
  text: string,
  profiles: readonly AgentProfile[],
): string | undefined {
  const mentioned = mentionedAgentProfiles(text, profiles);
  if (mentioned.length === 0) return undefined;
  const lines = mentioned.map(
    (profile) =>
      `- @${profile.name}: agentProfileId=${profile.id}${profile.role ? ` (${profile.role})` : ""}`,
  );
  return [
    "Saved agents mentioned in this message:",
    ...lines,
    "When the message asks a mentioned agent to do something, hand that work to it with session_create and its agentProfileId, then follow its result. A mention that only refers to an agent needs no handoff.",
  ].join("\n");
}

/**
 * The agent list shown above the composer while the message ends in "@name".
 * Picking replaces the partial mention with the agent's full name.
 */
export function AgentMentionMenu(props: {
  composer: ComposerState;
  profiles: readonly AgentProfile[];
}) {
  const match = TRAILING_MENTION.exec(props.composer.value);
  if (!match || props.profiles.length === 0) return null;
  const query = (match[2] ?? "").toLowerCase();
  const options = props.profiles
    .filter(
      (profile) =>
        query === "" ||
        profile.name.toLowerCase().startsWith(query) ||
        profile.name
          .toLowerCase()
          .split(/\s+/)
          .some((word) => word.startsWith(query)),
    )
    .slice(0, 5);
  if (options.length === 0) return null;
  const pick = (profile: AgentProfile) => {
    const value = props.composer.value;
    const start = value.length - (match[2]?.length ?? 0) - 1;
    props.composer.setValue(`${value.slice(0, start)}@${profile.name} `);
  };
  return (
    <div
      role="listbox"
      aria-label="Mention an agent"
      className={cn(MENU_SURFACE_CLASS, "mb-2 flex w-full max-w-sm flex-col p-1")}
    >
      <span className="px-2 pt-1 pb-1.5 text-2xs font-medium text-fg-muted">
        Hand off to an agent
      </span>
      {options.map((profile) => (
        <button
          key={profile.id}
          type="button"
          role="option"
          aria-selected={false}
          // Keep focus in the message field while picking.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(profile)}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-hidden"
        >
          <AgentMark avatar={profile.avatar} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-fg">{profile.name}</span>
            {profile.role ? (
              <span className="truncate text-2xs text-fg-subtle">{profile.role}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
