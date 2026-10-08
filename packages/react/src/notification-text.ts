/*
 * The small text format of an agent's notification, shared by every surface
 * that shows one (the web inbox, the native inbox): short paragraphs and "- "
 * bullets, with **bold**, `code` and [links](https://…) inside a line.
 * Anything else is shown as written. The phone's lock screen gets plain text
 * from the server instead.
 */

export type NotificationSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type NotificationBlock =
  | { kind: "paragraph"; spans: NotificationSpan[] }
  | { kind: "bullets"; items: NotificationSpan[][] };

const INLINE = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/gu;

/** One line's spans. Only https links become links. */
export function parseNotificationInline(line: string): NotificationSpan[] {
  const spans: NotificationSpan[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ kind: "text", text: line.slice(last, index) });
    const [, bold, boldAlt, code, linkText, href] = match;
    if (bold ?? boldAlt) spans.push({ kind: "bold", text: (bold ?? boldAlt)! });
    else if (code) spans.push({ kind: "code", text: code });
    else if (linkText && href) spans.push({ kind: "link", text: linkText, href });
    last = index + match[0].length;
  }
  if (last < line.length) spans.push({ kind: "text", text: line.slice(last) });
  return spans;
}

/** Paragraphs (blank-line separated; single line breaks kept) and bullet lists. */
export function parseNotificationText(text: string): NotificationBlock[] {
  const blocks: NotificationBlock[] = [];
  let paragraph: string[] = [];
  let bullets: NotificationSpan[][] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseNotificationInline(paragraph.join("\n")) });
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push({ kind: "bullets", items: bullets });
    bullets = [];
  };
  for (const raw of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(parseNotificationInline(bullet[1]!));
    } else if (line.trim() === "") {
      flushParagraph();
      flushBullets();
    } else {
      flushBullets();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushBullets();
  return blocks;
}

/** The text as one plain line, for previews that clamp to a line or two. */
export function notificationPlainText(text: string): string {
  return parseNotificationText(text)
    .map((block) =>
      block.kind === "paragraph"
        ? block.spans.map((span) => span.text).join("")
        : block.items.map((spans) => `• ${spans.map((span) => span.text).join("")}`).join("\n"),
    )
    .join("\n");
}
