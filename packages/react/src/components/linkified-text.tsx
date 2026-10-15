import { Fragment, type ReactNode } from "react";

// Bare http(s) URLs in plain agent-written text (question prompts, help text).
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// Sentence punctuation that follows a URL is not part of it.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export const LINKIFIED_LINK_CLASS = "font-medium og-link [overflow-wrap:anywhere]";

type Segment = { kind: "text"; value: string } | { kind: "link"; value: string };

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
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Split plain text into text and bare http(s) URL segments. */
export function linkifySegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (!isValidUrl(url)) continue;
    if (start > cursor) segments.push({ kind: "text", value: text.slice(cursor, start) });
    segments.push({ kind: "link", value: url });
    cursor = start + url.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

/**
 * Render plain text with bare http(s) URLs as links that open in a new tab and
 * wrap anywhere, so a long sign-in or approval URL stays clickable and inside
 * its card. Non-string nodes pass through unchanged.
 */
export function linkifyText(node: ReactNode): ReactNode {
  if (typeof node !== "string") return node;
  const segments = linkifySegments(node);
  if (!segments.some((segment) => segment.kind === "link")) return node;
  return segments.map((segment, index) =>
    segment.kind === "link" ? (
      <a
        key={index}
        className={LINKIFIED_LINK_CLASS}
        href={segment.value}
        target="_blank"
        rel="noreferrer noopener"
      >
        {segment.value}
      </a>
    ) : (
      <Fragment key={index}>{segment.value}</Fragment>
    ),
  );
}
