/**
 * Markdown to Slack mrkdwn for model-authored text OpenGeni posts to Slack.
 *
 * Agents write ordinary Markdown because the same reply renders as Markdown in
 * the OpenGeni console. Slack message text does not render Markdown headings,
 * `**bold**`, or `[label](url)` links, so a reply that reads well in the
 * console arrives in Slack full of literal syntax. This rewrites only that
 * syntax, only for the bytes handed to Slack: stored session events, model
 * history, and every other surface keep the model's exact text. It is
 * formatting at a third-party sink, not content classification or redaction.
 *
 * Code is never rewritten: fenced code blocks keep every line between their
 * fences, and inline code spans are copied as they are.
 *
 * The output is part of the Slack post and update ledgers' request digest, so a
 * change to it changes the bytes an in-flight operation is bound to. Delivery
 * (`deliverSlackModelText` in `slack-interactions.ts`) falls back only to the
 * unformatted text; a later output change must keep the previous rendering
 * reachable the same way, or operations started before the deploy conflict on
 * every retry.
 */

/**
 * A private provider citation handle: U+E200 `cite`, one or more U+E202
 * separated references, then U+E201. Codex web search can emit these without
 * the annotation table that would make them resolvable, so they carry nothing a
 * Slack reader can use. The OpenGeni timeline hides the same handles
 * (`stripOpaqueCitationTokens` in `packages/react/src/timeline/projection.ts`).
 */
const PROVIDER_CITATION_TOKEN =
  /[ \t]*\u{E200}(?:cite|filecite)(?:\u{E202}[^\u{E200}-\u{E202}]*)*\u{E201}/gu;
/** Stray citation delimiters, for example from a token cut short upstream. */
const PROVIDER_CITATION_DELIMITER = /[\u{E200}-\u{E202}]/gu;

/**
 * A fence at any indentation. Agents nest code under list items (a `10.` item
 * or a nested bullet puts the fence four or more spaces in), and Slack has no
 * indented code block, so a fence line is a fence wherever it starts.
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/u;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;
const BULLET = /^([ \t]*)[-*+][ \t]+(?=\S)/u;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;

/**
 * Spans that must reach Slack exactly as written and are set aside before any
 * link is read: inline code, and Slack's own `<...>` tokens (mentions, channel
 * links, and links already in Slack form).
 */
const CODE_SPAN_OR_SLACK_TOKEN =
  /(`+)(?!`)[^\n]*?(?<!`)\1(?!`)|<(?:[@#!]|https?:|mailto:)[^<>\n]*>/gu;

/**
 * A Markdown link or image whose target is a web or mail address. Other
 * targets, such as OpenGeni's own `artifact:` and `sandbox:` links, mean
 * nothing in Slack and are left as written rather than turned into dead links.
 * One level of balanced parentheses is allowed in the URL (as in Wikipedia
 * links), and an optional link title is dropped.
 */
const MARKDOWN_LINK =
  /!?\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\(\s*((?:https?:\/\/|mailto:)(?:[^\s()<>|]|\([^\s()<>|]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/gu;

/** Bare URLs are set aside after links: they may legitimately contain `__` or `**`. */
const BARE_URL = /\bhttps?:\/\/[^\s<>]+/gu;

const BOLD_ITALIC_ASTERISK = /\*\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))+?)(?<=[^\s*])\*\*\*/gu;
const BOLD_ASTERISK = /\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))+?)(?<=[^\s*])\*\*/gu;
const BOLD_UNDERSCORE =
  /(?<![\p{L}\p{N}_])__(?=[^\s_])((?:[^_\n]|_(?!_))+?)(?<=[^\s_])__(?![\p{L}\p{N}_])/gu;
const STRIKETHROUGH = /~~(?=[^\s~])((?:[^~\n]|~(?!~))+?)(?<=[^\s~])~~/gu;
const PLACEHOLDER = /\u0000(\d+)\u0000/gu;

/** Remove provider citation handles and any stray citation delimiters. */
export function stripProviderCitationMarkers(text: string): string {
  return text.replace(PROVIDER_CITATION_TOKEN, "").replace(PROVIDER_CITATION_DELIMITER, "");
}

/**
 * Rewrite common Markdown as Slack mrkdwn.
 *
 * - `# Heading` (any level) becomes a bold line.
 * - `**bold**` and `__bold__` become `*bold*`, `***both***` becomes `*_both_*`,
 *   and `~~struck~~` becomes `~struck~`.
 * - `[label](https://...)` becomes `<https://...|label>`.
 * - `-`, `*`, and `+` bullets become Slack's `•` bullet, keeping indentation;
 *   numbered lists and block quotes are already Slack syntax and stay as they are.
 * - Fenced code blocks, at any indentation, keep their contents byte for byte.
 *   The opening fence loses its language tag, which Slack would otherwise print
 *   as the first code line, and an unclosed block is closed so Slack still
 *   renders it as code.
 * - Provider citation handles are removed.
 *
 * Text that uses none of this syntax comes back unchanged.
 */
export function slackMrkdwnFromMarkdown(markdown: string): string {
  const lines = stripProviderCitationMarkers(markdown).split("\n");
  const output: string[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) {
        output.push("```");
        fence = null;
      } else {
        output.push(line);
      }
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    // A backtick fence's info string cannot contain a backtick; such a line is
    // inline code, not a fence.
    if (opening && !(opening[1]!.startsWith("`") && opening[2]!.includes("`"))) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      output.push("```");
      continue;
    }
    output.push(slackLine(line));
  }
  if (fence) output.push("```");
  return output.join("\n");
}

function closesFence(line: string, fence: { character: string; length: number }): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length &&
    [...trimmed].every((character) => character === fence.character)
  );
}

function slackLine(line: string): string {
  if (THEMATIC_BREAK.test(line)) return line;
  const heading = ATX_HEADING.exec(line);
  if (heading) {
    const content = slackInline(heading[1]!, { heading: true }).trim();
    return content ? `*${content}*` : line;
  }
  const bullet = BULLET.exec(line);
  if (bullet) {
    return `${bullet[1]}• ${slackInline(line.slice(bullet[0].length), { heading: false })}`;
  }
  return slackInline(line, { heading: false });
}

function slackInline(text: string, options: { heading: boolean }): string {
  const kept: string[] = [];
  const keep = (value: string) => {
    kept.push(value);
    return `\u0000${kept.length - 1}\u0000`;
  };
  // The placeholders are NUL-delimited, so a NUL in the model text itself
  // could collide with one. Slack does not render NUL; drop it.
  let working = text.replace(/\u0000/gu, "");
  working = working.replace(CODE_SPAN_OR_SLACK_TOKEN, keep);
  working = working.replace(MARKDOWN_LINK, (_match, label: string, url: string) =>
    keep(slackLink(restore(label, kept), url)),
  );
  working = working.replace(BARE_URL, keep);
  if (options.heading) {
    // The whole heading becomes one bold span, so emphasis inside it would
    // nest and break Slack's parser. Drop the emphasis markers instead.
    working = working
      .replace(BOLD_ASTERISK, "$1")
      .replace(BOLD_UNDERSCORE, "$1")
      .replace(/\*/gu, "");
  } else {
    working = working
      .replace(BOLD_ITALIC_ASTERISK, "*_$1_*")
      .replace(BOLD_ASTERISK, "*$1*")
      .replace(BOLD_UNDERSCORE, "*$1*");
  }
  working = working.replace(STRIKETHROUGH, "~$1~");
  return restore(working, kept);
}

function restore(text: string, kept: readonly string[]): string {
  return text.replace(PLACEHOLDER, (_match, index: string) => kept[Number(index)] ?? "");
}

function slackLink(label: string, url: string): string {
  const text = label
    .replace(BOLD_ASTERISK, "$1")
    .replace(BOLD_UNDERSCORE, "$1")
    .replace(/`/gu, "")
    .trim();
  if (!text || text === url) return `<${url}>`;
  return `<${url}|${escapeSlackLinkLabel(text)}>`;
}

/** Slack reads `&`, `<`, and `>` as control characters inside a link. */
function escapeSlackLinkLabel(label: string): string {
  return label.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
