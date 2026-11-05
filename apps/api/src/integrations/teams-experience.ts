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

export type TeamsCommand = "help" | "unlink" | "unlink_confirm";

/**
 * The fixed commands. Only the whole message counts, so "help me write a
 * plan" still goes to the agent.
 */
export function teamsCommand(text: string): TeamsCommand | null {
  const value = text
    .trim()
    .replace(/^\//, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (value === "help" || value === "commands") return "help";
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

function nextStep(state: TeamsExperienceState): TeamsExperienceReply["action"] | string | null {
  if (state.installation !== "active") return null;
  if (state.linked) return state.personal ? "Send a message to start a task." : null;
  return state.personal
    ? { kind: "link", title: "Link account" }
    : "Send me a direct message to link your Opengeni account, then mention me here again.";
}

function withNextStep(text: string, state: TeamsExperienceState): TeamsExperienceReply {
  const step = nextStep(state);
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
      "Send **help** at any time to see what I can do.",
    ].join("\n\n"),
    state,
  );
}

/** The reply to "help": the same in every state, plus the person's next step. */
export function teamsHelp(state: TeamsExperienceState): TeamsExperienceReply {
  const commands = [
    "- **help**: show this message",
    ...(state.personal
      ? ["- **unlink**: disconnect your Teams account from Opengeni"]
      : ["- **unlink**: send it to me in a direct message to disconnect your account"]),
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
  );
}

/** Replies for the unlink command and its confirmation. */
export function teamsUnlinkReply(
  step: "confirm" | "done" | "not_linked" | "not_personal",
): TeamsExperienceReply {
  switch (step) {
    case "confirm":
      return {
        text: "Unlink your Teams account from Opengeni? I'll stop working on your messages here until you link it again. Your chats stay in Opengeni.\n\nSelect **Unlink account** or send **unlink confirm**.",
        action: { kind: "command", title: "Unlink account", command: "unlink confirm" },
      };
    case "done":
      return {
        text: "Your Teams account is unlinked from Opengeni. Send me a message any time to link it again.",
      };
    case "not_linked":
      return { text: "Your Teams account isn't linked to Opengeni." };
    case "not_personal":
      return { text: "Send **unlink** to me in a direct message to disconnect your account." };
  }
}

/** The schema.org message entity that shows Teams' "AI generated" label. */
export const TEAMS_AI_GENERATED_ENTITY = {
  type: "https://schema.org/Message",
  "@type": "Message",
  "@context": "https://schema.org",
  "@id": "",
  additionalType: ["AIGeneratedContent"],
} as const;

/** A stable UUID for a provider event, so a redelivered event is the same request. */
export function teamsEventUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}\u0000${value}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 1;
}

/**
 * Agent Markdown in the subset Teams renders in text messages. Teams shows
 * bold, italics, strikethrough, links, lists, quotes, code and headings up to
 * level three; tables, images and horizontal rules show as raw characters.
 * Tables become one list item per row, deeper headings become bold lines,
 * images become links and rules are dropped. Code blocks are left as written.
 */
export function teamsMarkdown(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenced = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (
        fenced &&
        fenced[1]![0] === fence[0] &&
        fenced[1]!.length >= fence.length &&
        !fenced[2]!.trim()
      )
        fence = null;
      continue;
    }
    if (fenced) {
      fence = fenced[1]!;
      out.push(line);
      continue;
    }
    const next = lines[index + 1];
    if (tableRow(line) && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-")) {
      const header = tableCells(line);
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
        if (pairs.length) rows.push(`- ${pairs.join("; ")}`);
      }
      out.push(...(rows.length ? rows : [header.filter(Boolean).join(" · ")]));
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      out.push(
        heading[1]!.length <= 3 ? `${heading[1]} ${heading[2]}` : `**${heading[2]!.trim()}**`,
      );
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      out.push("");
      continue;
    }
    out.push(
      line
        .replace(
          /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)/g,
          (_match, alt: string, url: string) => `[${alt.trim() || url}](${url})`,
        )
        .replace(
          /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/,
          (_match, marker: string, checked: string) => `${marker}${checked === " " ? "☐" : "☑"} `,
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
 */
export function teamsMarkdownParts(text: string, maxBytes = TEAMS_PART_BYTES): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  let fence: { marker: string; open: string } | null = null;
  const size = (value: string) => Buffer.byteLength(value);
  const reserve = () => (fence ? size(`\n${fence.marker}`) : 0);
  const reopened = () => (fence ? `${fence.open}\n` : "");
  const flush = () => {
    if (!part || part === reopened()) return;
    if (fence) part += part.endsWith("\n") ? fence.marker : `\n${fence.marker}`;
    parts.push(part);
    part = reopened();
    bytes = size(part);
  };
  const lines = text.split(/(?<=\n)/);
  for (const line of lines) {
    const lineBytes = size(line);
    if (bytes + lineBytes + reserve() > maxBytes) flush();
    if (bytes + lineBytes + reserve() > maxBytes) {
      // One line longer than a part: split it by characters.
      const limit = maxBytes - reserve();
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
    const fenced = FENCE.exec(line.replace(/\n$/, ""));
    if (fence) {
      if (
        fenced &&
        fenced[1]![0] === fence.marker[0] &&
        fenced[1]!.length >= fence.marker.length &&
        !fenced[2]!.trim()
      )
        fence = null;
    } else if (fenced) fence = { marker: fenced[1]!, open: line.replace(/\n$/, "") };
  }
  if (part && part !== reopened()) parts.push(part);
  return parts;
}
