/**
 * text.ts - keyword variants, word splitting, stopwords and small text helpers.
 */

/** Split an identifier or phrase into lowercase words: fooBarBAZ_qux-v2 -> [foo, bar, baz, qux, v2]. */
export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/**
 * Identifier variants of a keyword. The search is case-insensitive, so only the
 * separator forms matter: concatenated (camel/Pascal/flat), snake/SCREAMING, kebab, spaced phrase.
 * Returned in display casing (camel, snake, kebab, spaced) for the trace; deduped case-insensitively.
 */
export function keywordVariants(kw: string): string[] {
  const raw = kw.trim();
  if (!raw) return [];
  const words = splitWords(raw);
  const out: string[] = [raw];
  if (words.length >= 2) {
    out.push(words[0] + words.slice(1).map(cap).join("")); // camelCase (== PascalCase / flat under -i)
    out.push(words.join("_")); // snake_case (== SCREAMING_SNAKE under -i)
    out.push(words.join("-")); // kebab-case
    out.push(words.join(" ")); // spaced phrase (prose in docs)
  }
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = v.toLowerCase();
    if (seen.has(k) || k.length < 2) return false;
    seen.add(k);
    return true;
  });
}

/** Contiguous 2-word fragments of a compound with >= 3 words (fallback when the full name has no hits). */
export function compoundFragments(kw: string): string[] {
  const words = splitWords(kw);
  if (words.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (a.length + b.length < 8) continue; // skip tiny fragments like "is" + "on"
    out.push(a + cap(b));
  }
  return [...new Set(out)];
}

/** A single plain word (no case change, no separator) short enough to need a word boundary. */
export function isShortPlainWord(kw: string, maxLen: number): boolean {
  return /^[A-Za-z]+$/.test(kw) && kw.length <= maxLen && splitWords(kw).length === 1;
}

/** Escape for Rust regex (ripgrep). */
export function escapeRegex(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, (m) => `\\${m}`);
}

export const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing done for from had has have how i if in into is it its " +
    "just me my no not of on or our should so some such than that the their them then there these they this those to " +
    "too was we were what when where which while who why will with would you your also any each else ever every much " +
    "more most other same very about above after again against all am before being below between both during few " +
    "further here him his her hers himself itself let may might must nor now off once only own over under until up " +
    "use used using want way get got make makes happen happens happening still actually really even whether instead " +
    "rather something someone thing things one two three kind already mean means"
  ).split(" "),
);

/** Crude stemmer: good enough for overlap scoring (not for display). */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && (s.endsWith("ing") || s.endsWith("ers"))) s = s.slice(0, -3);
  else if (s.length > 4 && (s.endsWith("ed") || s.endsWith("es") || s.endsWith("er")))
    s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/** Content terms of a text (identifiers split into words, stopwords dropped, stemmed, deduped). */
export function contentTerms(text: string, minLen = 3): string[] {
  const out = new Set<string>();
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    for (const w of splitWords(tok)) {
      if (w.length < minLen || STOPWORDS.has(w)) continue;
      out.add(stem(w));
    }
  }
  return [...out];
}

/** Fraction of `terms` present in `textTerms`. */
export function overlap(terms: string[], textTerms: Set<string>): number {
  if (!terms.length) return 0;
  let n = 0;
  for (const t of terms) if (textTerms.has(t)) n++;
  return n / terms.length;
}

export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p)
  );
}

/** Release notes: CHANGELOG*, HISTORY*, RELEASE_NOTES*, .changeset/ entries (describe past changes, not current code). */
export function isChangelogPath(p: string): boolean {
  return (
    /(^|\/)(CHANGELOG|HISTORY|RELEASE[-_]?NOTES)[^/]*$/i.test(p) || /(^|\/)\.changeset\//.test(p)
  );
}

/** Is the question about history / releases (then release notes are not down-weighted)? */
export function questionMentionsHistory(q: string): boolean {
  return /\b(changelog|release notes?|released|history|historical|when (?:was|did)|which version|since version|changed in)\b/i.test(
    q,
  );
}

export function isDocPath(p: string): boolean {
  return /\.(md|mdx|txt|rst)$/i.test(p);
}

export function questionMentionsTests(q: string): boolean {
  return /\b(test|tests|testing|spec|specs|unit test|e2e|fixture)\b/i.test(q);
}

/** Trim a line to maxChars around the first occurrence of any needle (case-insensitive). */
export function trimAround(line: string, needles: string[], maxChars: number): string {
  const t = line.replace(/\t/g, "  ").trim();
  if (t.length <= maxChars) return t;
  const lower = t.toLowerCase();
  let at = -1;
  for (const n of needles) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return t.slice(0, maxChars - 3) + "...";
  const start = Math.max(0, Math.min(at - Math.floor(maxChars / 3), t.length - maxChars));
  const s = t.slice(start, start + maxChars - 6);
  return (start > 0 ? "..." : "") + s + (start + maxChars - 6 < t.length ? "..." : "");
}

export function estTokens(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

export function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
