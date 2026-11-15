/**
 * Source links without the tracking a hosted web search adds to them.
 *
 * OpenAI's hosted web search tags the pages it returns with
 * `utm_source=openai` (or a ChatGPT value), and sometimes with `_t_q`, the
 * search query that found the page. Models then cite those URLs in their
 * answers, so a reader sees a stray search query and a provider name in every
 * source link. These helpers remove exactly those parameters for display and
 * delivery. They act only on a URL that carries the provider's `utm_source`
 * value, and keep every other parameter (including other `utm_*` ones), the
 * fragment and the original encoding byte for byte.
 *
 * Use them where an answer is shown or delivered, never on stored history or
 * on text sent to a model: an earlier model request must keep its bytes.
 */

import { splitMarkdownCode } from "./markdown-code";

/** `utm_source` values a hosted search provider writes onto source links. */
const PROVIDER_SOURCES = new Set(["openai", "chatgpt.com", "chatgpt"]);
/** The hosted search's own parameter carrying the query that found the page. */
const SEARCH_QUERY_KEYS = new Set(["_t_q"]);

/**
 * The URL without hosted-search tracking. A URL without the provider's
 * `utm_source` comes back unchanged, as does anything that is not a URL.
 */
export function withoutProviderTracking(url: string): string {
  const queryAt = url.indexOf("?");
  if (queryAt < 0) return url;
  const hashAt = url.indexOf("#");
  if (hashAt >= 0 && hashAt < queryAt) return url;
  const end = hashAt < 0 ? url.length : hashAt;
  const parts = url.slice(queryAt + 1, end).split("&");
  if (!parts.some(isProviderSource)) return url;
  const kept = parts.filter(
    (part) => part.length > 0 && !isProviderSource(part) && !SEARCH_QUERY_KEYS.has(keyOf(part)),
  );
  const query = kept.length > 0 ? `?${kept.join("&")}` : "";
  return `${url.slice(0, queryAt)}${query}${url.slice(end)}`;
}

/**
 * The text with hosted-search tracking removed from every http(s) URL in it,
 * in Markdown links, autolinks and bare URLs alike. Fenced and inline code keep
 * their contents exactly. Text with nothing to remove comes back unchanged.
 */
export function withoutProviderTrackingInText(text: string): string {
  if (!text.includes("utm_source=")) return text;
  return splitMarkdownCode(text)
    .map((segment) => (segment.code ? segment.text : cleanProse(segment.text)))
    .join("");
}

/** A run that may be a URL; its trailing punctuation is trimmed below. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`[\]{}|\\^]+/giu;

function cleanProse(prose: string): string {
  if (!prose.includes("utm_source=")) return prose;
  return prose.replace(URL_CANDIDATE, (candidate) => {
    const url = withoutTrailingPunctuation(candidate);
    return withoutProviderTracking(url) + candidate.slice(url.length);
  });
}

/**
 * The URL without punctuation that ends the sentence or a Markdown link
 * around it: trailing `.,;:!?*_~` and closing parentheses that have no
 * opening one inside the URL, as GitHub's autolinks do.
 */
function withoutTrailingPunctuation(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last && ".,;:!?*_~".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && count(url, ")") > count(url, "(")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function count(text: string, character: string): number {
  let n = 0;
  for (const c of text) if (c === character) n += 1;
  return n;
}

function isProviderSource(part: string): boolean {
  if (keyOf(part) !== "utm_source") return false;
  const at = part.indexOf("=");
  return (
    at >= 0 &&
    PROVIDER_SOURCES.has(
      decode(part.slice(at + 1))
        .trim()
        .toLowerCase(),
    )
  );
}

function keyOf(part: string): string {
  const at = part.indexOf("=");
  return decode(at < 0 ? part : part.slice(0, at));
}

function decode(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/gu, " "));
  } catch {
    return component;
  }
}
