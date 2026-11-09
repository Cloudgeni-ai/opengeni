import { createHash } from "node:crypto";

/**
 * What a person in Teams sees from Opengeni outside agent replies: the
 * welcome, help and account commands, and how agent Markdown is shaped for
 * Teams. Everything here is deterministic and never calls a model.
 */

/** Where the person stands, which decides the welcome and help they get. */
export type TeamsExperienceState = {
  /** A 1:1 chat with the bot, as opposed to a group chat or channel. */
  personal: boolean;
  /**
   * Whether the person's Teams organization is connected to an Opengeni
   * workspace ("active"), or not yet ("unavailable").
   */
  installation: "active" | "unavailable";
  /** Whether this Teams identity is linked to an Opengeni account. */
  linked: boolean;
  /**
   * Whether any group chat or channel in the person's organization is enabled
   * for Opengeni. Only then does help in a 1:1 chat mention them.
   */
  sharedConversations?: boolean;
  /**
   * How an organization that isn't connected can connect: "connect" when its
   * Microsoft 365 or Teams admin can connect it from Teams, "work_account"
   * when the person uses a personal Microsoft account, which can't.
   */
  setup?: "connect" | "work_account";
  /**
   * The operator's support address, for an organization that isn't connected
   * when there is no other way forward.
   */
  supportEmail?: string;
  /**
   * The name the bot uses for itself, the package's short name (Opengeni by
   * default). Text about the service and accounts always says Opengeni.
   */
  appName?: string;
};

/** The app name when none is configured. */
export const TEAMS_DEFAULT_APP_NAME = "Opengeni";

/** One deterministic reply: Teams Markdown text and an optional card button. */
export type TeamsExperienceReply = {
  text: string;
  action?: { kind: "link"; title: string } | { kind: "command"; title: string; command: string };
};

export type TeamsCommand = "help" | "link" | "unlink" | "unlink_confirm";

/**
 * The fixed commands. Only the whole message counts, so "help me write a
 * plan" still goes to the agent.
 */
export function teamsCommand(text: string): TeamsCommand | null {
  if (text.length > 64) return null;
  const value = text
    .trim()
    .replace(/^\//, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (value === "help" || value === "commands") return "help";
  if (value === "link") return "link";
  if (value === "unlink" || value === "disconnect") return "unlink";
  if (value === "unlink confirm" || value === "disconnect confirm") return "unlink_confirm";
  return null;
}

const about = (appName: string) =>
  `${appName} is an AI agent that works on tasks for you: it answers questions, researches, writes, and works with the tools your organization connects. Replies are AI-generated and can be wrong, so check important details.`;
const LIMITS = [
  "You need an Opengeni account, and your organization must connect Opengeni to Microsoft Teams.",
  "I read text messages. Files and images sent in Teams aren't supported yet.",
  "Approvals and requests for private information open Opengeni in your web browser.",
];

/** How an organization that isn't connected yet connects. Plain text. */
export const TEAMS_CONNECT_TEXT =
  "Your organization hasn't connected Opengeni yet. A Microsoft 365 Global Administrator or Teams Administrator connects it once for everyone. If that's you, select Connect your organization. Otherwise, ask your admin to message Opengeni in Teams and connect it.";
/** For a person signed in to Teams with a personal Microsoft account. Plain text. */
export const TEAMS_WORK_ACCOUNT_TEXT =
  "Opengeni needs a Microsoft 365 work or school account. You're using Teams with a personal Microsoft account, which can't connect to Opengeni. Sign in to Teams with your work or school account to use Opengeni.";
/** A short reminder once the Connect your organization cards are used up. */
export const TEAMS_CONNECT_REMINDER_TEXT =
  "Your organization hasn't connected Opengeni yet. Send **help** to see how to connect it.";
/** For a group chat or channel in an organization that isn't connected. */
export const TEAMS_SHARED_CONNECT_TEXT =
  "Your organization hasn't connected Opengeni yet. Send me a direct message to see how to connect it.";
/** For a mention in a group chat or channel Opengeni isn't turned on in. */
export function teamsConversationOffText(appName: string = TEAMS_DEFAULT_APP_NAME): string {
  return `${appName} isn't turned on in this conversation. Send me a direct message to give me a task instead.`;
}
/** For a linked person whose account can't start chats in the connected workspace. */
export const TEAMS_CANNOT_START_TEXT =
  "Your Opengeni account can't start chats in the workspace your organization connected to Microsoft Teams. Ask an admin of that workspace to give you access to start chats, then message me again.";
/** The same, in a group chat or channel, without naming one person's access there. */
export const TEAMS_SHARED_CANNOT_START_TEXT =
  "I can't start a task for you here. Send me a direct message to see why.";
/** For a 1:1 message with a file or image, or with no text. */
export const TEAMS_UNREADABLE_MESSAGE_TEXT =
  "I can only read text messages. Files and images sent in Teams aren't supported yet, so send your request as text.";

type NextStep = { text: string; action?: TeamsExperienceReply["action"] };

/**
 * The person's next step. A help reply links straight to account linking; a
 * welcome, which may be read long after it was sent, offers a button that
 * asks for a fresh link instead. In an organization that isn't connected,
 * the step is how to connect it.
 */
function nextStep(state: TeamsExperienceState, reply: "welcome" | "help"): NextStep | null {
  if (state.installation !== "active") {
    if (!state.personal) return { text: TEAMS_SHARED_CONNECT_TEXT };
    if (state.setup === "connect")
      return reply === "welcome"
        ? { text: TEAMS_CONNECT_REMINDER_TEXT }
        : {
            text: TEAMS_CONNECT_TEXT,
            action: { kind: "link", title: "Connect your organization" },
          };
    if (state.setup === "work_account") return { text: TEAMS_WORK_ACCOUNT_TEXT };
    return state.supportEmail
      ? {
          text: `To get Opengeni for your organization, your Microsoft 365 or Teams admin can contact ${state.supportEmail}.`,
        }
      : null;
  }
  if (state.linked) return state.personal ? { text: "Send a message to start a task." } : null;
  if (!state.personal)
    return {
      text: "Send me a direct message to link your Opengeni account, then mention me here again.",
    };
  return {
    text: "Link your Opengeni account to start.",
    action:
      reply === "welcome"
        ? { kind: "command", title: "Link account", command: "link" }
        : { kind: "link", title: "Link account" },
  };
}

function withNextStep(
  text: string,
  state: TeamsExperienceState,
  reply: "welcome" | "help",
): TeamsExperienceReply {
  const step = nextStep(state, reply);
  if (!step) return { text };
  return { text: `${text}\n\n${step.text}`, ...(step.action ? { action: step.action } : {}) };
}

/** Sent once when someone adds the bot for themselves. */
export function teamsWelcome(state: TeamsExperienceState): TeamsExperienceReply {
  const appName = state.appName ?? TEAMS_DEFAULT_APP_NAME;
  return withNextStep(
    teamsMarkdown(
      [
        `**Welcome to ${appName}**`,
        about(appName),
        LIMITS.map((line) => `- ${line}`).join("\n"),
        "Send **help** at any time for tips and commands, or **unlink** to disconnect your account.",
      ].join("\n\n"),
    ),
    state,
    "welcome",
  );
}

/** The reply to "help": the same in every state, plus the person's next step. */
export function teamsHelp(state: TeamsExperienceState): TeamsExperienceReply {
  const appName = state.appName ?? TEAMS_DEFAULT_APP_NAME;
  const commands = [
    "- **help**: show this message",
    ...(state.personal
      ? [
          "- **link**: link your Teams account to Opengeni",
          "- **unlink**: disconnect your Teams account from Opengeni",
        ]
      : ["- **link** or **unlink**: send them to me in a direct message to manage your account"]),
  ];
  const tips = [
    ...LIMITS,
    ...(!state.personal
      ? ["Mention me in this conversation to give me a task."]
      : state.sharedConversations
        ? [`In a group chat or channel where ${appName} is enabled, mention me to give me a task.`]
        : []),
    "Use the thumbs up or down on a reply to tell us how it went.",
  ];
  return withNextStep(
    teamsMarkdown(
      [
        `**${appName} help**`,
        `${about(appName)} Describe what you need and I'll reply here when the task is done.`,
        `**Commands**\n${commands.join("\n")}`,
        `**Good to know**\n${tips.map((line) => `- ${line}`).join("\n")}`,
      ].join("\n\n"),
    ),
    state,
    "help",
  );
}

/** Replies for the link and unlink commands. */
export function teamsAccountReply(
  step: "already_linked" | "confirm" | "done" | "not_linked" | "not_personal",
): TeamsExperienceReply {
  switch (step) {
    case "already_linked":
      return {
        text: "Your Teams account is already linked to Opengeni. Send a message to start a task, or **unlink** to disconnect it.",
      };
    case "confirm":
      return {
        text: "Unlink your Teams account from Opengeni? I'll stop working on your messages here until you link it again. Your chats stay in Opengeni.\n\nSelect **Unlink account** or send **unlink confirm**.",
        action: { kind: "command", title: "Unlink account", command: "unlink confirm" },
      };
    case "done":
      return {
        text: "Your Teams account is unlinked from Opengeni. Send **link** any time to link it again.",
      };
    case "not_linked":
      return { text: "Your Teams account isn't linked to Opengeni." };
    case "not_personal":
      return {
        text: "Send **link** or **unlink** to me in a direct message to manage your account.",
      };
  }
}

/**
 * The reply to unlink from someone who isn't linked: that, and how to link
 * the account, or to connect the organization first.
 */
export function teamsNotLinkedReply(state: TeamsExperienceState): TeamsExperienceReply {
  return withNextStep(teamsAccountReply("not_linked").text, { ...state, linked: false }, "help");
}

/** The schema.org message entity that shows Teams' "AI generated" label. */
export function teamsAiGeneratedEntity() {
  return {
    type: "https://schema.org/Message" as const,
    "@type": "Message" as const,
    "@context": "https://schema.org" as const,
    "@id": "" as const,
    additionalType: ["AIGeneratedContent"],
  };
}

/** A link shown as a button under a notice instead of a bare URL in its text. */
export type TeamsNoticeLink = { title: string; url: string };

/**
 * A notice from Opengeni itself, such as "Started", as an Adaptive Card: its
 * paragraphs and a button that opens the link. In a channel thread Teams
 * starts a new message header after a card, so the agent's answer that
 * follows gets its own header and AI label instead of being grouped under the
 * notice.
 */
export function teamsNoticeCard(text: string, link: TeamsNoticeLink) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json" as const,
    type: "AdaptiveCard" as const,
    version: "1.2" as const,
    // Shown by clients that can't render the card.
    fallbackText: teamsPlainPreview(text),
    body: text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => ({ type: "TextBlock" as const, text: paragraph, wrap: true })),
    actions: [{ type: "Action.OpenUrl" as const, title: link.title, url: link.url }],
  };
}

/**
 * A short plain-text version of an Opengeni notice, for clients that can't
 * show cards: headings, strong emphasis, code marks and link targets removed,
 * whitespace collapsed, at most `max` characters (never splitting one).
 */
export function teamsPlainPreview(text: string, max = 200): string {
  const plain = text
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : plain;
}

/** A stable UUID for a provider event, so a redelivered event is the same request. */
export function teamsEventUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}\u0000${value}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Lines longer than this are passed through unchanged and never treated as
 * Markdown structure. Real tables, headings and fences are far shorter, and
 * it keeps every pattern below cheap on any input.
 */
const STRUCTURE_LINE_LIMIT = 4096;

type Fence = { marker: string; info: string; indent: number };

/**
 * A code fence line: three or more backticks or tildes, then an info string.
 * Fences indented four or more spaces count only where `deep` is allowed,
 * such as inside a list item; elsewhere such a line is indented code.
 */
function fenceLine(line: string, deep = false): Fence | null {
  if (line.length > 1024) return null;
  const match = /^( *)(`{3,}|~{3,})([^\n]*)$/.exec(line.replace(/\n$/, ""));
  if (!match) return null;
  const indent = match[1]!.length;
  if (indent > 3 && !deep) return null;
  const marker = match[2]!;
  const info = match[3]!;
  // A backtick fence's info string can't contain backticks.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { marker, info, indent };
}

/** A closing fence: the same character, at least as long, no info string,
 * indented at most three spaces more than its opening fence. */
function closesFence(line: string, open: Fence): boolean {
  const fence = fenceLine(line, true);
  return Boolean(
    fence &&
    fence.indent <= open.indent + 3 &&
    fence.marker[0] === open.marker[0] &&
    fence.marker.length >= open.marker.length &&
    !fence.info.trim(),
  );
}

function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableRow(line: string): boolean {
  return (
    line.length <= STRUCTURE_LINE_LIMIT &&
    line.includes("|") &&
    line.trim().length > 1 &&
    !/^(?: {4}|\t)/.test(line)
  );
}

/** A table's delimiter row, with one cell per header cell. */
function tableSeparator(line: string | undefined, columns: number): boolean {
  if (line === undefined || line.length > STRUCTURE_LINE_LIMIT) return false;
  if (!/^[\s|:-]+$/.test(line) || !line.includes("-") || /^(?: {4}|\t)/.test(line)) return false;
  const cells = tableCells(line);
  return cells.length === columns && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function heading(line: string): { level: number; text: string } | null {
  // `[^]*` matches any character, so the pattern never backtracks.
  const match = /^ {0,3}(#{1,6})[ \t]+([^]*)$/.exec(line);
  if (!match) return null;
  // An optional closing sequence of #s, after whitespace, isn't part of the text.
  let text = match[2]!.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t"))
    text = text.slice(0, end).trimEnd();
  return { level: match[1]!.length, text };
}

/**
 * A line that is bold and nothing else, such as `**Next steps**` or
 * `**Risks:**`: agents use it as a heading. Bounded and linear: the bold text
 * can't contain the delimiter character.
 */
function boldHeading(line: string): boolean {
  return (
    line.length <= 300 &&
    (/^ {0,3}\*\*(?=\S)[^*\n]*[^*\s]\*\*:?[ \t]*$/.test(line) ||
      /^ {0,3}__(?=\S)[^_\n]*[^_\s]__:?[ \t]*$/.test(line))
  );
}

/** Ordinary paragraph text: not a list, quote, heading, code, fence or spacer. */
function paragraphLine(line: string): boolean {
  return (
    Boolean(line.trim()) &&
    !/^[ \t]/.test(line) &&
    !/^(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})(?:[ \t]|$)|>|`{3,}|~{3,}|<br>$)/.test(line) &&
    !boldHeading(line)
  );
}

/**
 * Teams shows paragraphs with no gap between them, so a heading right after
 * a paragraph would sit directly under it. An empty `<br>` paragraph before
 * the heading gives it the gap a heading needs. Lists, quotes and code
 * already have a gap after them, and the first line needs none.
 */
const HEADING_GAP = "<br>";
function gapBeforeHeading(out: string[]): void {
  let previous = out.length - 1;
  while (previous >= 0 && !out[previous]!.trim()) previous -= 1;
  if (previous < 0 || !paragraphLine(out[previous]!)) return;
  if (out.at(-1)!.trim()) out.push("");
  out.push(HEADING_GAP, "");
}

/**
 * One table row as list items. Teams can't show tables in text messages, and
 * cells joined on one line run together, so a row becomes a bullet led by its
 * first cell with every other cell on its own line beneath it.
 */
function tableRowItems(header: string[], cells: string[]): string[] {
  const lead = cells[0] ?? "";
  const rest = cells.slice(1).flatMap((cell, column) => {
    if (!cell) return [];
    const title = header[column + 1];
    return [title ? `${title}: ${cell}` : cell];
  });
  if (!lead) return rest.length ? [`- ${rest[0]}`, ...rest.slice(1).map((x) => `  - ${x}`)] : [];
  const bold = header.length > 1 && !lead.includes("**") ? `**${lead}**` : lead;
  return [`- ${bold}`, ...rest.map((item) => `  - ${item}`)];
}

/**
 * Text that looks like an HTML tag, such as `List<string>` or `<name>`, would
 * be read by Teams as markup and disappear. Escape it, leaving autolinks such
 * as <https://example.com>, `<br>` and link targets alone. Linear: each `)`
 * search resumes where the last one stopped, and each `<` is checked with
 * bounded sticky patterns.
 */
const KEPT_TAG =
  /<br[ \t]{0,2}\/?>|<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]{0,2048}>|<[^\s<>@]{1,256}@[^\s<>@]{1,256}>/iy;
function escapeTagsInText(text: string): string {
  if (!text.includes("<")) return text;
  let out = "";
  let start = 0;
  /** The next `)` at or after some earlier search point; -1 when none is left. */
  let paren = -2;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "]" && text[index + 1] === "(") {
      // A link target is a URL, not text: keep it as written.
      if (paren !== -1 && paren < index + 2) paren = text.indexOf(")", index + 2);
      if (paren !== -1 && paren - index <= 2100) {
        index = paren;
        continue;
      }
    }
    if (char !== "<" || !/[A-Za-z/!?]/.test(text[index + 1] ?? "")) continue;
    KEPT_TAG.lastIndex = index;
    if (!KEPT_TAG.test(text)) {
      out += `${text.slice(start, index)}\\`;
      start = index;
    }
  }
  return out + text.slice(start);
}

const IMAGE =
  /!\[([^[\]\n]{0,512})\]\([ \t]{0,8}([^\s()]{1,2048})(?:[ \t]+"[^"\n]{0,512}")?[ \t]{0,8}\)/g;

/**
 * Rewrites the text of one line outside its code spans, which are kept as
 * written: tag-like text is escaped and, with `images`, images become links.
 * One pass: the closing run for each backtick length is found by a pointer
 * that only moves forward.
 */
function escapeTags(line: string, images = false): string {
  const rewrite = (text: string) =>
    escapeTagsInText(
      images && text.includes("![")
        ? text.replace(
            IMAGE,
            (_match, alt: string, url: string) => `[${alt.trim() || url}](${url})`,
          )
        : text,
    );
  if (!line.includes("`")) return rewrite(line);
  /** Start positions of every maximal backtick run, by run length. */
  const runs = new Map<number, number[]>();
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (line[end] === "`") end += 1;
    const list = runs.get(end - index) ?? [];
    list.push(index);
    runs.set(end - index, list);
    index = end;
  }
  const cursor = new Map<number, number>();
  const closing = (at: number, length: number) => {
    const list = runs.get(length);
    if (!list) return -1;
    let next = cursor.get(length) ?? 0;
    while (next < list.length && list[next]! <= at) next += 1;
    cursor.set(length, next);
    return next < list.length ? list[next]! : -1;
  };
  let out = "";
  let start = 0;
  for (let index = 0; index < line.length;) {
    const char = line[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char !== "`") {
      index += 1;
      continue;
    }
    let run = 1;
    while (line[index + run] === "`") run += 1;
    const close = closing(index, run);
    if (close === -1) {
      index += run;
      continue;
    }
    out += rewrite(line.slice(start, index)) + line.slice(index, close + run);
    index = close + run;
    start = index;
  }
  return out + rewrite(line.slice(start));
}

/**
 * Agent Markdown in the subset Teams renders in text messages. Teams shows
 * bold, italics, strikethrough, links, lists, quotes, code and headings up to
 * level three; tables, images and horizontal rules show as raw characters,
 * and text that looks like an HTML tag disappears. Tables become one list
 * item per row with its other cells beneath it, deeper headings become bold
 * lines, images become links, rules are dropped and tag-like text is escaped.
 * Teams leaves no gap between paragraphs, so a heading or a bold heading line
 * after a paragraph gets an empty paragraph before it, and a bold heading
 * line is kept on its own line. Code blocks are left as written.
 */
export function teamsMarkdown(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: Fence | null = null;
  /** The index of the last line that was ordinary paragraph text. */
  let plainLine = -1;
  /** Inside a list, indented lines continue an item instead of being code. */
  let inList = false;
  /** The index of the last line of an indented code block. */
  let codeLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const indented = /^(?: {4}|\t)/.test(line);
    const blank = !line.trim();
    if (
      indented &&
      !inList &&
      (codeLine === index - 1 || index === 0 || !lines[index - 1]!.trim())
    ) {
      // Indented code: shown as written, so nothing in it is converted.
      codeLine = index;
      out.push(line);
      continue;
    }
    if (blank && codeLine === index - 1) codeLine = index;
    if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) inList = true;
    else if (!blank && !/^[ \t]/.test(line)) inList = false;
    const opened = fenceLine(line, inList);
    if (opened) {
      fence = opened;
      out.push(line);
      continue;
    }
    if (line.length > STRUCTURE_LINE_LIMIT) {
      out.push(escapeTags(line));
      continue;
    }
    if (tableRow(line)) {
      const header = tableCells(line);
      if (tableSeparator(lines[index + 1], header.length)) {
        index += 1;
        const rows: string[] = [];
        while (index + 1 < lines.length && tableRow(lines[index + 1]!)) {
          const cells = tableCells(lines[index + 1]!);
          index += 1;
          for (const item of tableRowItems(header, cells)) rows.push(escapeTags(item));
        }
        out.push(...(rows.length ? rows : [escapeTags(header.filter(Boolean).join(" · "))]));
        continue;
      }
    }
    const title = heading(line);
    if (title) {
      gapBeforeHeading(out);
      out.push(
        escapeTags(
          title.level <= 3 ? `${"#".repeat(title.level)} ${title.text}` : `**${title.text}**`,
        ),
      );
      continue;
    }
    // A line of = or - under a paragraph line underlines it as a heading.
    const previous = lines[index - 1];
    if (
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) &&
      previous !== undefined &&
      plainLine === index - 1 &&
      previous.trim()
    ) {
      const text = out.pop()!.trim();
      gapBeforeHeading(out);
      out.push(`${line.trim()[0] === "=" ? "#" : "##"} ${text}`);
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      out.push("");
      continue;
    }
    const underline = lines[index + 1];
    if (
      boldHeading(line) &&
      // An indented bold line inside a list item stays part of the item.
      !(inList && /^[ \t]/.test(line)) &&
      // A bold line with = or - under it is a setext heading, handled below.
      !(underline !== undefined && /^ {0,3}(?:=+|-+)[ \t]*$/.test(underline))
    ) {
      // A heading line that continues a paragraph starts its own instead.
      if (out.length && out.at(-1)!.trim() && paragraphLine(out.at(-1)!)) out.push("");
      gapBeforeHeading(out);
      out.push(escapeTags(line.trim()));
      // The next line, text or another bold line, would otherwise join it on
      // the same line.
      const next = lines[index + 1];
      if (next !== undefined && next.trim() && (paragraphLine(next) || boldHeading(next)))
        out.push("");
      continue;
    }
    if (line.trim() && !/^ {0,3}(?:[-*+>]|\d{1,9}[.)])(?:[ \t]|$)|^(?: {4}|\t)/.test(line))
      plainLine = index;
    out.push(
      escapeTags(
        line.replace(
          /^([ \t]{0,12}(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})\[([ xX])\][ \t]/,
          (_match, marker: string, checked: string) => `${marker}${checked === " " ? "☐" : "☑"} `,
        ),
        true,
      ),
    );
  }
  return out.join("\n");
}

/** Largest Teams message part, in UTF-8 bytes. */
export const TEAMS_PART_BYTES = 20_000;

/**
 * Splits a message into parts within the Teams size limit, at line breaks
 * where possible. A code block cut between parts is closed at the end of one
 * part and reopened at the start of the next, so both still render as code.
 * The reopening line carries only the fence and its language, and room for
 * the closing fence is kept from the moment a block opens, so no part ever
 * exceeds the limit.
 */
export function teamsMarkdownParts(text: string, maxBytes = TEAMS_PART_BYTES): string[] {
  /** An open code block. Its reopen line is null when it wouldn't comfortably
   * fit a part; such a block is still tracked, just not closed and reopened. */
  type OpenFence = { fence: Fence; close: string; reopen: string | null };
  const size = (value: string) => Buffer.byteLength(value);
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  let fence: OpenFence | null = null;
  const closeBytes = (f: OpenFence | null) => (f?.reopen ? size(`\n${f.close}`) : 0);
  const open = (f: Fence): OpenFence => {
    const language = /^[\w#+.-]{1,32}/.exec(f.info.trim())?.[0] ?? "";
    const reopen = `${f.marker}${language}\n`;
    const close = `${" ".repeat(f.indent)}${f.marker}`;
    return {
      fence: f,
      close,
      // A block nested in a list item isn't reopened: the next part has no
      // list, so its indented lines already show as code there.
      reopen: f.indent <= 3 && size(reopen) + size(`\n${close}`) <= maxBytes / 4 ? reopen : null,
    };
  };
  const reopened = () => fence?.reopen ?? "";
  const flush = () => {
    if (!part || part === reopened()) return;
    // The gap before a heading that starts the next part isn't needed here.
    if (!fence) part = part.replace(/\n\n<br>\n\n?$/, "\n");
    if (fence?.reopen) part += part.endsWith("\n") ? fence.close : `\n${fence.close}`;
    parts.push(part);
    part = reopened();
    bytes = size(part);
  };
  for (const line of text.split(/(?<=\n)/)) {
    const lineBytes = size(line);
    // The fence state once this line is in, so its closing fence has room.
    let next: OpenFence | null = fence;
    if (fence) {
      if (closesFence(line, fence.fence)) next = null;
    } else {
      const opened = fenceLine(line, true);
      if (opened) next = open(opened);
    }
    if (bytes + lineBytes + closeBytes(next) > maxBytes) flush();
    if (bytes + lineBytes + closeBytes(next) > maxBytes) {
      // One line longer than a part: split it by characters. A fence line this
      // long can't open or close a block.
      next = fence;
      const limit = maxBytes - closeBytes(fence);
      for (const c of line) {
        const charBytes = c.length === 1 && c.charCodeAt(0) < 0x80 ? 1 : size(c);
        if (bytes + charBytes > limit) flush();
        part += c;
        bytes += charBytes;
      }
    } else {
      part += line;
      bytes += lineBytes;
    }
    fence = next;
  }
  if (part && part !== reopened()) parts.push(part);
  return parts;
}
