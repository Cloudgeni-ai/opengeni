/**
 * The request text a chat started from Slack shows and stores: what the person
 * wrote, without the leading mention of Opengeni, with the people it mentions
 * by name ("@Sam" rather than "<@U0123>"). The model is told which Slack user
 * each name is, so it can still mention them.
 */

const SLACK_USER_MENTION = /<@([UW][A-Z0-9]{1,40})(?:\|([^>]{1,256}))?>/gu;

/** At most this many different people are looked up for one message. */
export const MAX_SLACK_MENTIONED_USERS = 10;

/** The Slack users a message mentions, other than Opengeni, in order, without repeats. */
export function slackMentionedUserIds(text: string, botUserId: string | null): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(SLACK_USER_MENTION)) {
    const id = match[1]!;
    if (id !== botUserId && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_SLACK_MENTIONED_USERS);
}

export type SlackReadableRequest = {
  /** The text to show and store. */
  text: string;
  /** For the model: which Slack user each name stands for; null when none was replaced. */
  modelContext: string | null;
};

/**
 * Remove a leading mention of Opengeni and show other mentions by name: the
 * name Slack gave, or the label inside the mention. A mention of Opengeni
 * later in the text reads "@Opengeni"; a person with no known name keeps the
 * raw mention. Text that would be empty is returned as written.
 */
export function slackReadableRequestText(
  text: string,
  botUserId: string | null,
  names: ReadonlyMap<string, string>,
): SlackReadableRequest {
  const withoutLead = withoutLeadingMention(text, botUserId);
  const replaced = new Map<string, string>();
  // Two people with the same name keep their raw mentions, so they stay apart.
  const nameOf = (id: string, label: string | undefined) =>
    names.get(id)?.trim() || label?.trim() || null;
  const owners = new Map<string, Set<string>>();
  for (const match of withoutLead.matchAll(SLACK_USER_MENTION)) {
    const name = nameOf(match[1]!, match[2]);
    if (name && match[1] !== botUserId) {
      owners.set(name, (owners.get(name) ?? new Set()).add(match[1]!));
    }
  }
  const readable = withoutLead.replace(
    SLACK_USER_MENTION,
    (whole, id: string, label: string | undefined) => {
      if (id === botUserId) return "@Opengeni";
      const name = nameOf(id, label);
      if (!name || (owners.get(name)?.size ?? 0) > 1) return whole;
      replaced.set(id, name);
      return `@${name}`;
    },
  );
  if (readable.trim().length === 0) return { text, modelContext: null };
  const lines = [...replaced].map(([id, name]) => `- @${name} is <@${id}>`);
  return {
    text: readable,
    modelContext:
      lines.length > 0
        ? ["People mentioned, by name; to mention one in Slack, use the id:", ...lines].join("\n")
        : null,
  };
}

function withoutLeadingMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text;
  const trimmed = text.trimStart();
  const open = `<@${botUserId}`;
  if (!trimmed.startsWith(open)) return text;
  const close = trimmed.indexOf(">", open.length);
  const next = trimmed[open.length];
  if (close < 0 || (next !== ">" && next !== "|")) return text;
  return trimmed.slice(close + 1).replace(/^[\s,:]+/u, "");
}
