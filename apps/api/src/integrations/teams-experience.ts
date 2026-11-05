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
};

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

const ABOUT =
  "Opengeni is an AI agent that works on tasks for you: it answers questions, researches, writes, and works with the tools your organization connects. Replies are AI-generated and can be wrong, so check important details.";
const LIMITS = [
  "You need an Opengeni account, and your organization must connect Opengeni to Microsoft Teams.",
  "I read text messages. Files and images sent in Teams aren't supported yet.",
  "Approvals and requests for private information open in the Opengeni app.",
];

/**
 * The person's next step. A help reply links straight to account linking; a
 * welcome, which may be read long after it was sent, offers a button that
 * asks for a fresh link instead.
 */
function nextStep(
  state: TeamsExperienceState,
  reply: "welcome" | "help",
): TeamsExperienceReply["action"] | string | null {
  if (state.installation !== "active") return null;
  if (state.linked) return state.personal ? "Send a message to start a task." : null;
  if (!state.personal)
    return "Send me a direct message to link your Opengeni account, then mention me here again.";
  return reply === "welcome"
    ? { kind: "command", title: "Link account", command: "link" }
    : { kind: "link", title: "Link account" };
}

function withNextStep(
  text: string,
  state: TeamsExperienceState,
  reply: "welcome" | "help",
): TeamsExperienceReply {
  const step = nextStep(state, reply);
  if (!step) return { text };
  if (typeof step === "string") return { text: `${text}\n\n${step}` };
  return { text: `${text}\n\nLink your Opengeni account to start.`, action: step };
}

/** Sent once when someone adds the bot for themselves. */
export function teamsWelcome(state: TeamsExperienceState): TeamsExperienceReply {
  return withNextStep(
    [
      "**Welcome to Opengeni**",
      ABOUT,
      LIMITS.map((line) => `- ${line}`).join("\n"),
      "Send **help** at any time for tips and commands, or **unlink** to disconnect your account.",
    ].join("\n\n"),
    state,
    "welcome",
  );
}

/** The reply to "help": the same in every state, plus the person's next step. */
export function teamsHelp(state: TeamsExperienceState): TeamsExperienceReply {
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
    state.personal
      ? "In group chats and channels, mention me to ask for help."
      : "Mention me in this conversation to give me a task.",
    "Use the thumbs up or down on a reply to tell us how it went.",
  ];
  return withNextStep(
    [
      "**Opengeni help**",
      `${ABOUT} Describe what you need and I'll reply here when the task is done.`,
      `**Commands**\n${commands.join("\n")}`,
      `**Good to know**\n${tips.map((line) => `- ${line}`).join("\n")}`,
    ].join("\n\n"),
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
 * Text that looks like an HTML tag, such as `List<string>` or `<name>`, would
 * be read by Teams as markup and disappear. Escape it outside code spans,
 * leaving autolinks such as <https://example.com> and link targets alone.
 */
function escapeTags(line: string): string {
  if (!line.includes("<")) return line;
  let out = "";
  let index = 0;
  /** Backtick run lengths with no closing run later in the line. */
  const unclosed = new Set<number>();
  while (index < line.length) {
    const char = line[index]!;
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      const marker = "`".repeat(run);
      let close = unclosed.has(run) ? -1 : line.indexOf(marker, index + run);
      while (close !== -1 && line[close + run] === "`") {
        let skip = close;
        while (line[skip] === "`") skip += 1;
        close = line.indexOf(marker, skip);
      }
      if (close === -1) {
        unclosed.add(run);
        out += marker;
        index += run;
      } else {
        out += line.slice(index, close + run);
        index = close + run;
      }
      continue;
    }
    if (char === "]" && line[index + 1] === "(") {
      // A link target is a URL, not text: keep it as written.
      const end = line.indexOf(")", index + 2);
      if (end !== -1 && end - index <= 2100) {
        out += line.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    if (char === "\\" && index + 1 < line.length) {
      out += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (
      char === "<" &&
      /[A-Za-z/!?]/.test(line[index + 1] ?? "") &&
      !/^<br\s{0,2}\/?>/i.test(line.slice(index, index + 8)) &&
      !/^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.test(line.slice(index, index + 2100)) &&
      !/^<[^\s<>@]+@[^\s<>@]+>/.test(line.slice(index, index + 320))
    ) {
      out += "\\<";
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Agent Markdown in the subset Teams renders in text messages. Teams shows
 * bold, italics, strikethrough, links, lists, quotes, code and headings up to
 * level three; tables, images and horizontal rules show as raw characters,
 * and text that looks like an HTML tag disappears. Tables become one list
 * item per row, deeper headings become bold lines, images become links, rules
 * are dropped and tag-like text is escaped. Code blocks are left as written.
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
          const pairs = cells.flatMap((cell, column) => {
            if (!cell) return [];
            const title = header[column];
            return [title ? `**${title}:** ${cell}` : cell];
          });
          if (pairs.length) rows.push(escapeTags(`- ${pairs.join("; ")}`));
        }
        out.push(...(rows.length ? rows : [escapeTags(header.filter(Boolean).join(" · "))]));
        continue;
      }
    }
    const title = heading(line);
    if (title) {
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
      out[out.length - 1] = `${line.trim()[0] === "=" ? "#" : "##"} ${out.at(-1)!.trim()}`;
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      out.push("");
      continue;
    }
    if (line.trim() && !/^ {0,3}(?:[-*+>]|\d{1,9}[.)])(?:[ \t]|$)|^(?: {4}|\t)/.test(line))
      plainLine = index;
    out.push(
      escapeTags(
        line
          .replace(
            /!\[([^\]\n]{0,512})\]\([ \t]{0,8}([^\s()]{1,2048})(?:[ \t]+"[^"\n]{0,512}")?[ \t]{0,8}\)/g,
            (_match, alt: string, url: string) => `[${alt.trim() || url}](${url})`,
          )
          .replace(
            /^([ \t]{0,12}(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})\[([ xX])\][ \t]/,
            (_match, marker: string, checked: string) => `${marker}${checked === " " ? "☐" : "☑"} `,
          ),
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
