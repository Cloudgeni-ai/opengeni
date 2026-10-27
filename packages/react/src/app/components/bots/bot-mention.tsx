import type { SessionAvatar as SessionAvatarValue, SessionListEntry } from "@opengeni/sdk";
import { useMemo } from "react";

import type { ComposerState } from "../../../hooks/use-composer";
import { useWorkspaceSessions } from "../../../hooks/use-workspace-sessions";
import { MENU_SURFACE_CLASS } from "../../../ui/menu-styles";
import { cn } from "../../lib/utils";
import {
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "../session/session-avatar";

/* ----------------------------------------------------------------------------
   @mention a bot. A bot is a chat with a name and a face (docs/bots.md), so
   mentioning one means "send this to that chat": typing "@" at the end of a
   message lists the workspace's bots, and picking one writes "@Name". When the
   message is sent, each mentioned bot's chat id rides along as the message's
   context, and the chat's agent hands the request to the bot with
   session_send_message, where it keeps its own context and setup. A mention
   grants nothing: the agent's ordinary session authority still applies.
   -------------------------------------------------------------------------- */

/** A bot the person picked from the mention list. */
export type MentionedBot = {
  sessionId: string;
  name: string;
  description: string | null;
};

const TRAILING_MENTION = /(^|\s)@([\p{L}\p{N}_.-]{0,40})$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The picked bots whose "@Name" is still in the text, in order of first mention. */
export function mentionedBots(text: string, bots: readonly MentionedBot[]): MentionedBot[] {
  const found: Array<{ at: number; bot: MentionedBot }> = [];
  const seen = new Set<string>();
  for (const bot of bots) {
    if (seen.has(bot.sessionId)) continue;
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])@${escapeRegExp(bot.name)}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    const match = pattern.exec(text);
    if (!match) continue;
    seen.add(bot.sessionId);
    found.push({ at: match.index, bot });
  }
  return found.sort((left, right) => left.at - right.at).map((entry) => entry.bot);
}

/** The message context naming each mentioned bot, or undefined when none is mentioned. */
export function botMentionContext(
  text: string,
  bots: readonly MentionedBot[],
  /** The chat the message is sent in: a bot mentioned in its own chat does the work here. */
  currentSessionId?: string | undefined,
): string | undefined {
  const mentioned = mentionedBots(text, bots);
  if (mentioned.length === 0) return undefined;
  const lines = mentioned.map((bot) =>
    bot.sessionId === currentSessionId
      ? `- @${bot.name}: this chat (do the work here)`
      : `- @${bot.name}: sessionId=${bot.sessionId}${bot.description ? ` (${bot.description})` : ""}`,
  );
  return [
    "Bots mentioned in this message (each is a chat in this workspace):",
    ...lines,
    "When the message asks a mentioned bot to do something, send that request to the bot's chat with session_send_message so it keeps its own context and setup, then follow its result. A mention that only refers to a bot needs no handoff.",
  ].join("\n");
}

function botName(entry: SessionListEntry): string {
  return (entry.title ?? entry.displayTitle ?? "").trim();
}

/** A chat that has a description or avatar is a bot. */
function isBot(entry: SessionListEntry): boolean {
  return Boolean(entry.avatar || entry.description) && botName(entry).length > 0 && !entry.archived;
}

function avatarFor(entry: SessionListEntry): SessionAvatarValue {
  return (
    entry.avatar ?? {
      kind: "letters",
      letters: sessionAvatarInitials(botName(entry)),
      hue: sessionAvatarFallbackHue(entry.id),
    }
  );
}

/**
 * The bots shown above the composer while the message ends in "@name".
 * Picking replaces the partial mention with the bot's full name and reports
 * the bot, so its chat id can travel with the message.
 */
export function BotMentionMenu(props: {
  composer: ComposerState;
  workspaceId: string;
  currentSessionId: string;
  onPick: (bot: MentionedBot) => void;
}) {
  const match = TRAILING_MENTION.exec(props.composer.value);
  const query = match ? (match[2] ?? "") : null;
  const { sessions } = useWorkspaceSessions({
    projection: "summary",
    limit: 50,
    search: query ? query : undefined,
    enabled: query !== null,
  });
  const options = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return sessions
      .filter((entry) => entry.workspaceId === props.workspaceId)
      .filter((entry) => entry.id !== props.currentSessionId && isBot(entry))
      .filter(
        (entry) =>
          needle === "" ||
          botName(entry)
            .toLowerCase()
            .split(/\s+/)
            .some((word) => word.startsWith(needle)),
      )
      .slice(0, 5);
  }, [props.currentSessionId, props.workspaceId, query, sessions]);
  if (!match || options.length === 0) return null;
  const pick = (entry: SessionListEntry) => {
    const name = botName(entry);
    const value = props.composer.value;
    const start = value.length - (match[2]?.length ?? 0) - 1;
    props.composer.setValue(`${value.slice(0, start)}@${name} `);
    props.onPick({ sessionId: entry.id, name, description: entry.description ?? null });
  };
  return (
    <div
      role="listbox"
      aria-label="Mention a bot"
      className={cn(MENU_SURFACE_CLASS, "mb-2 flex w-full max-w-sm flex-col p-1")}
    >
      <span className="px-2 pt-1 pb-1.5 text-2xs font-medium text-fg-muted">Send to a bot</span>
      {options.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="option"
          aria-selected={false}
          // Keep focus in the message field while picking.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(entry)}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-hidden"
        >
          <SessionAvatar
            avatar={avatarFor(entry)}
            name={botName(entry)}
            workspaceId={props.workspaceId}
            seed={entry.id}
            size="md"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-fg">{botName(entry)}</span>
            {entry.description ? (
              <span className="truncate text-2xs text-fg-subtle">{entry.description}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
