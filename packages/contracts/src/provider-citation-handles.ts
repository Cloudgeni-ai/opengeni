/**
 * Web-search citation handles a model leaves in its answer text.
 *
 * OpenAI models that search the web through a Codex or ChatGPT subscription
 * write citations as private-use handles: U+E200, `cite` or `filecite`, one
 * or more U+E202-separated references such as `turn0search3` or
 * `turn2view0`, then U+E201. ChatGPT resolves them against search metadata
 * its own app receives; the responses Opengeni gets carry no table that maps
 * a reference to a page (no URL annotations, and the search calls hold no
 * reference ids), so a handle names nothing a reader can open. Shown as
 * written, the delimiters render as boxes or vanish and the reader sees
 * `citeturn0search3` in the middle of a sentence.
 *
 * A handle also arrives without its delimiters (`citeturn0search3turn1view0`,
 * when a model writes one as plain text), cut short, or still streaming at the
 * end of the text. Ordinary words such as "cite" and "excited" stay.
 *
 * Use this where an answer is shown or delivered to a person, never on stored
 * history or on text sent to a model: an earlier model request must keep its
 * bytes. It is its own module so code that only cleans links does not load it.
 */

const PROVIDER_CITATION_HANDLE =
  /\s*\u{E200}(?:file)?cite(?:\u{E202}[^\u{E200}-\u{E202}]*)*\u{E201}/gu;
/** A handle whose end has not streamed in yet, or never will. */
const UNFINISHED_PROVIDER_CITATION_HANDLE = /\s*\u{E200}[^\u{E201}\s]*$/u;
const PROVIDER_CITATION_DELIMITER = /[\u{E200}-\u{E202}]/gu;
/** `cite` or `filecite` glued to one or more references, which no prose writes. */
const BARE_PROVIDER_CITATION_HANDLE = /[ \t]*(?:file)?cite(?:turn\d+[a-z_]+\d+)+/gu;

/** Whether the text may hold a citation handle; a cheap check before rewriting. */
function mayHoldHandle(text: string): boolean {
  return /[\u{E200}-\u{E202}]|cite(?:turn\d)/u.test(text);
}

/**
 * The text without web-search citation handles: complete ones with the space
 * before them, plain-text ones, one still streaming at the end, and stray
 * delimiters from one cut short. Text without any comes back unchanged.
 */
export function withoutProviderCitationHandles(text: string): string {
  if (!mayHoldHandle(text)) return text;
  return text
    .replace(PROVIDER_CITATION_HANDLE, "")
    .replace(UNFINISHED_PROVIDER_CITATION_HANDLE, "")
    .replace(PROVIDER_CITATION_DELIMITER, "")
    .replace(BARE_PROVIDER_CITATION_HANDLE, "");
}
