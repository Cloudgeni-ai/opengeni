import { Fragment, type ReactNode } from "react";

// Bare http(s) URLs and Markdown `[label](url)` links in plain agent-written
// text (question prompts, help text, option descriptions).
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// Sentence punctuation that follows a URL is not part of it.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export const LINKIFIED_LINK_CLASS = "font-medium og-link [overflow-wrap:anywhere]";

type Segment =
  | { kind: "text"; value: string }
  /** `value` is the href; `label` is the visible text of a Markdown link. */
  | { kind: "link"; value: string; label?: string };

type PositionedSegment = { segment: Segment; start: number };

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  // Drop a closing paren that wraps the URL rather than belonging to it.
  while (url.endsWith(")") && countOf(url, "(") < countOf(url, ")")) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

function countOf(value: string, char: string): number {
  let count = 0;
  for (const current of value) if (current === char) count += 1;
  return count;
}

function isValidUrl(value: string): boolean {
  try {
    return /^https?:$/u.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Parse a Markdown inline link `[label](http(s)://url)` starting at `open`
 * (the `[`). The URL may contain balanced parentheses. Returns null when the
 * text there is not a well-formed http(s) link, so it stays plain text.
 */
function parseMarkdownLink(
  text: string,
  open: number,
): { label: string; url: string; end: number } | null {
  const close = text.indexOf("]", open + 1);
  if (close < 0 || text[close + 1] !== "(") return null;
  const label = text.slice(open + 1, close);
  if (!label.trim() || /[[\n]/u.test(label)) return null;
  let depth = 0;
  for (let index = close + 2; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/u.test(char)) return null;
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) {
        const url = text.slice(close + 2, index);
        return isValidUrl(url) ? { label: label.trim(), url, end: index + 1 } : null;
      }
      depth -= 1;
    }
  }
  return null;
}

function bareUrlSegments(text: string, offset: number, into: PositionedSegment[]): void {
  let cursor = 0;
  const pushText = (value: string, start: number) => {
    if (value) into.push({ segment: { kind: "text", value }, start: offset + start });
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (!isValidUrl(url)) continue;
    pushText(text.slice(cursor, start), cursor);
    into.push({ segment: { kind: "link", value: url }, start: offset + start });
    cursor = start + url.length;
  }
  pushText(text.slice(cursor), cursor);
}

function positionedSegments(text: string): PositionedSegment[] {
  const segments: PositionedSegment[] = [];
  let cursor = 0;
  let search = 0;
  while (search < text.length) {
    const open = text.indexOf("[", search);
    if (open < 0) break;
    const link = parseMarkdownLink(text, open);
    if (!link) {
      search = open + 1;
      continue;
    }
    bareUrlSegments(text.slice(cursor, open), cursor, segments);
    segments.push({ segment: { kind: "link", value: link.url, label: link.label }, start: open });
    cursor = link.end;
    search = link.end;
  }
  bareUrlSegments(text.slice(cursor), cursor, segments);
  // Merge adjacent text pieces so callers see one run between links.
  const merged: PositionedSegment[] = [];
  for (const entry of segments) {
    const previous = merged.at(-1);
    if (previous?.segment.kind === "text" && entry.segment.kind === "text") {
      previous.segment = { kind: "text", value: previous.segment.value + entry.segment.value };
    } else {
      merged.push({ segment: { ...entry.segment }, start: entry.start });
    }
  }
  return merged;
}

/** Split plain text into text, bare http(s) URL, and Markdown link segments. */
export function linkifySegments(text: string): Segment[] {
  return positionedSegments(text).map((entry) => entry.segment);
}

/**
 * Render plain text with bare http(s) URLs and Markdown `[label](url)` links as
 * links that open in a new tab and wrap anywhere, so a long sign-in or approval
 * URL stays clickable and inside its card. Non-string nodes pass through
 * unchanged.
 */
export function linkifyText(node: ReactNode): ReactNode {
  if (typeof node !== "string") return node;
  const segments = positionedSegments(node);
  if (!segments.some((entry) => entry.segment.kind === "link")) return node;
  // Each segment's source offset is a stable unique key.
  return segments.map(({ segment, start }) =>
    segment.kind === "link" ? (
      <a
        key={start}
        className={LINKIFIED_LINK_CLASS}
        href={segment.value}
        target="_blank"
        rel="noreferrer noopener"
      >
        {segment.label ?? segment.value}
      </a>
    ) : (
      <Fragment key={start}>{segment.value}</Fragment>
    ),
  );
}
