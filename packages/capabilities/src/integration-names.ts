/**
 * Whether a piece of text (a search query) names an integration: by its
 * name, its name written with other spacing or case, a near spelling of a
 * long name, or its vendor's word in its provider domain. Shared by the
 * integration catalog ranking and by tool search, which offers a Connect card
 * only for an integration the query names.
 */

// Common two-label public suffixes. Without a full public-suffix list this
// keeps hosts such as api.example.co.uk on example.co.uk rather than co.uk.
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.uk",
  "co.uk",
  "gov.uk",
  "org.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.cn",
  "com.mx",
  "com.sg",
  "com.tr",
]);

/** The registrable domain of a host name (api.example.co.uk -> example.co.uk), or null. */
export function registrableHostDomain(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".") || null;
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * Registrable domains that host many unrelated vendors' servers, so their
 * word ("vercel", "googleapis") says nothing about which vendor it is.
 */
const SHARED_HOSTING_DOMAINS = new Set([
  "amazonaws.com",
  "appspot.com",
  "awsapprunner.com",
  "azurewebsites.net",
  "cloudfunctions.net",
  "deno.dev",
  "firebaseapp.com",
  "fly.dev",
  "github.io",
  "glitch.me",
  "googleapis.com",
  "herokuapp.com",
  "netlify.app",
  "ngrok.app",
  "ngrok.io",
  "onrender.com",
  "pages.dev",
  "railway.app",
  "replit.app",
  "run.app",
  "supabase.co",
  "vercel.app",
  "web.app",
  "workers.dev",
]);

/** Lower-case letter-and-digit words of a text, NFKC-normalized. */
export function integrationNameWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The vendor's own word in a provider domain: the label before its public
 * suffix ("jira" for jira.com, "synthflow" for docs.synthflow.ai), when it is
 * one word of four or more letters on a domain that is not shared hosting.
 */
export function integrationVendorWord(providerDomain: string | null | undefined): string | null {
  const registrable = providerDomain ? registrableHostDomain(providerDomain) : null;
  if (!registrable || SHARED_HOSTING_DOMAINS.has(registrable)) return null;
  const words = integrationNameWords(registrable.split(".")[0] ?? "");
  return words.length === 1 && words[0]!.length >= 4 ? words[0]! : null;
}

/**
 * Short words that never join their neighbours into one name: "linked in" is
 * not LinkedIn, "follow up work" not Upwork, "add one note" not OneNote.
 */
const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "off",
  "on",
  "one",
  "or",
  "our",
  "out",
  "so",
  "the",
  "this",
  "that",
  "to",
  "up",
  "with",
  "your",
]);

/**
 * Words that open a noun phrase: after one, separate words describe a thing
 * ("on the last pass", "my work day") rather than spell a name.
 */
const DETERMINERS = new Set([
  "a",
  "an",
  "any",
  "each",
  "every",
  "her",
  "his",
  "its",
  "my",
  "our",
  "some",
  "the",
  "their",
  "these",
  "this",
  "those",
  "that",
  "your",
]);

/** Whether every letter of `short` appears in `long`, in order. */
function isSubsequence(short: readonly string[], long: readonly string[]): boolean {
  let index = 0;
  for (const letter of long) if (letter === short[index]) index += 1;
  return index === short.length;
}

/**
 * Whether a written word is a near spelling of a name (both lower case,
 * without spaces). It must start with the name's first letter. For a name of
 * eight or more letters it may add up to one letter (two from nine letters:
 * "whisperflow" for "wisprflow"), drop one letter from inside the name, or
 * swap two neighbouring letters; for five to seven letters it may only swap
 * two neighbouring letters ("hubsopt", "slakc"). A replaced letter is never a
 * near spelling ("automation" is not AutoMotion, "conference" not
 * Confluence), nor is the name's start or end alone ("context" is not
 * Context7, "grammar" not Grammarly). Shorter names, and other changes to
 * names under eight letters, would meet common words ("Gmail" and "email",
 * "Stripe" and "strike", "Discord" and "discard").
 */
export function isIntegrationNearSpelling(word: string, name: string): boolean {
  if (Math.abs(word.length - name.length) > 2) return false;
  // A plural of the name is the ordinary word it is ("snowflakes").
  if (word === `${name}s` || word === `${name}es`) return false;
  const w = Array.from(word);
  const n = Array.from(name);
  if (n.length < 5 || w[0] !== n[0] || word === name) return false;
  const extra = n.length >= 9 ? 2 : n.length === 8 ? 1 : 0;
  if (w.length > n.length) return w.length - n.length <= extra && isSubsequence(n, w);
  if (w.length < n.length)
    return (
      extra > 0 &&
      n.length - w.length === 1 &&
      !name.startsWith(word) &&
      !name.endsWith(word) &&
      isSubsequence(w, n)
    );
  const differ = w.flatMap((letter, index) => (letter === n[index] ? [] : [index]));
  return (
    differ.length === 2 &&
    differ[1] === differ[0]! + 1 &&
    w[differ[0]!] === n[differ[1]!] &&
    w[differ[1]!] === n[differ[0]!]
  );
}

/**
 * How a query names an integration: its whole name as words ("name"); a
 * name of several words written as one ("unspaced": "wisprflow" for Wispr
 * Flow); a one-word name written as its parts ("joined": "hub spot" for
 * HubSpot); a near spelling of it ("near_spelling"); or its vendor's domain
 * word ("domain": "jira" for Atlassian at jira.com), unless differently named
 * products share that domain (see sharedVendorDomains).
 */
export type IntegrationMentionKind = "name" | "unspaced" | "joined" | "near_spelling" | "domain";

export type IntegrationMention = {
  kind: IntegrationMentionKind;
  /**
   * Written with a capital first letter where a sentence does not start
   * ("search Linear issues", but not "Close the ticket").
   */
  capitalised: boolean;
};

/** A query word, lower case, and whether it was capitalised mid-sentence. */
export type IntegrationQueryWord = { word: string; capitalised: boolean };

/**
 * The query's words, lower case, each marked when it starts with a capital
 * where a sentence does not start ("search Linear issues").
 */
export function integrationQueryWords(query: string): IntegrationQueryWord[] {
  const text = query.normalize("NFKC");
  const words: IntegrationQueryWord[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0;
    const opensSentence = words.length === 0 || /[.!?:;\n]/.test(text.slice(previousEnd, start));
    words.push({
      word: match[0].toLowerCase(),
      capitalised: !opensSentence && /^\p{Lu}/u.test(match[0]),
    });
    previousEnd = start + match[0].length;
  }
  return words;
}

/** Name parts at spaces, punctuation and inner capitals: "HubSpot" -> hub, spot. */
function namePartWords(name: string): string[] {
  return integrationNameWords(name.normalize("NFKC").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));
}

export type IntegrationMentionMatcher = (integration: {
  name: string;
  providerDomain?: string | null | undefined;
}) => IntegrationMention[];

type IntegrationNameShape = {
  nameWords: string[];
  compact: string;
  spacedName: string;
  parts: string;
  firstLetter: string;
  vendorWord: string | null;
  registrableDomain: string | null;
};

// Catalog ranking reads the same few thousand entries for every query.
const nameShapes = new Map<string, IntegrationNameShape | null>();
const MAX_CACHED_NAME_SHAPES = 20_000;

function integrationNameShape(
  name: string,
  providerDomain: string | null | undefined,
): IntegrationNameShape | null {
  const key = `${name}\u0000${providerDomain ?? ""}`;
  const cached = nameShapes.get(key);
  if (cached !== undefined) return cached;
  const nameWords = integrationNameWords(name);
  const compact = nameWords.join("");
  const shape: IntegrationNameShape | null = nameWords.length
    ? {
        nameWords,
        compact,
        spacedName: nameWords.join(" "),
        parts: namePartWords(name).join(" "),
        firstLetter: Array.from(compact)[0]!,
        vendorWord: integrationVendorWord(providerDomain),
        registrableDomain: providerDomain ? registrableHostDomain(providerDomain) : null,
      }
    : null;
  if (nameShapes.size >= MAX_CACHED_NAME_SHAPES) nameShapes.clear();
  nameShapes.set(key, shape);
  return shape;
}

/** Whether two integration names agree: equal, or one the other's start ("Atlassian (v1)"). */
export function integrationNamesAgree(first: string, second: string): boolean {
  const a = integrationNameWords(first).join("");
  const b = integrationNameWords(second).join("");
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Registrable domains that several products with different names share
 * (microsoft.com for Teams, Excel and OneDrive). Their vendor word names
 * none of them; jira.com for Atlassian and Atlassian (v1) is one product.
 */
export function sharedVendorDomains(
  integrations: Iterable<{ name: string; providerDomain?: string | null | undefined }>,
): Set<string> {
  const firstName = new Map<string, string>();
  const shared = new Set<string>();
  for (const { name, providerDomain } of integrations) {
    const domain = integrationNameShape(name, providerDomain)?.registrableDomain;
    if (!domain || shared.has(domain)) continue;
    const seen = firstName.get(domain);
    if (seen === undefined) firstName.set(domain, name);
    else if (!integrationNamesAgree(seen, name)) shared.add(domain);
  }
  return shared;
}

/**
 * Reads the query once and returns a function that lists every way it names
 * a given integration, in query order. Catalog ranking asks about thousands
 * of entries for one query, so an entry whose first letter starts no query
 * word, and whose vendor word is not a query word, is rejected before any
 * spelling comparison.
 */
export function integrationMentionMatcher(
  query: string,
  options: { sharedDomains?: ReadonlySet<string> } = {},
): IntegrationMentionMatcher {
  const words = integrationQueryWords(query);
  const firstLetters = new Set(words.map(({ word }) => word[0]));
  const writtenWords = new Set(words.map(({ word }) => word));
  return (integration) => {
    if (!words.length) return [];
    const shape = integrationNameShape(integration.name, integration.providerDomain);
    if (!shape) return [];
    const { nameWords, compact, spacedName, parts, vendorWord } = shape;
    const domainWord =
      vendorWord &&
      vendorWord !== compact &&
      !nameWords.includes(vendorWord) &&
      writtenWords.has(vendorWord) &&
      !options.sharedDomains?.has(shape.registrableDomain ?? "")
        ? vendorWord
        : null;
    const nameFirstLetter = shape.firstLetter;
    if (!domainWord && !firstLetters.has(nameFirstLetter)) return [];
    const mentions: IntegrationMention[] = [];
    const widest = Math.min(Math.max(nameWords.length, parts.split(" ").length) + 1, 4);
    for (let start = 0; start < words.length; start += 1) {
      const { word: first, capitalised } = words[start]!;
      if (first === domainWord) mentions.push({ kind: "domain", capitalised });
      if (!first.startsWith(nameFirstLetter)) continue;
      for (let width = 1; width <= widest && start + width <= words.length; width += 1) {
        const window = words.slice(start, start + width).map((w) => w.word);
        const spaced = window.join(" ");
        if (spaced === spacedName) {
          mentions.push({ kind: "name", capitalised });
          continue;
        }
        if (width > 1 && window.some((word) => FUNCTION_WORDS.has(word))) continue;
        const joined = window.join("");
        if (joined === compact) {
          // Separate words join only at the name's own parts: "hub spot" is
          // HubSpot, "work day" is not Workday, and "the last pass" is a
          // phrase, not LastPass.
          if (width === 1) mentions.push({ kind: "unspaced", capitalised });
          else if (spaced === parts && !DETERMINERS.has(words[start - 1]?.word ?? ""))
            mentions.push({ kind: "joined", capitalised });
        } else if (isIntegrationNearSpelling(joined, compact))
          mentions.push({ kind: "near_spelling", capitalised });
      }
    }
    return mentions;
  };
}

/** Every way the query names the integration, in query order. */
export function integrationMentionsIn(
  query: string,
  integration: { name: string; providerDomain?: string | null | undefined },
  options: { sharedDomains?: ReadonlySet<string> } = {},
): IntegrationMention[] {
  return integrationMentionMatcher(query, options)(integration);
}

/**
 * Whether a mention is evidence enough on its own that the query means the
 * integration and not ordinary words: any mention capitalised mid-sentence; a
 * near spelling; the vendor's domain word when it differs from the name
 * ("jira" for Atlassian: brand words, almost never ordinary ones); a name of
 * several words, as words or as one word ("google calendar", "wisprflow"); or
 * a one-word name that is not an ordinary word in shape (inner capitals or
 * digits: "hubspot", "context7"). "close the ticket", "linear regression",
 * "the box is empty" and "hub spot" written as two words are not.
 */
export function isDistinctiveIntegrationMention(
  mention: IntegrationMention,
  integrationName: string,
): boolean {
  if (
    mention.capitalised ||
    mention.kind === "near_spelling" ||
    mention.kind === "unspaced" ||
    mention.kind === "domain"
  )
    return true;
  if (mention.kind !== "name") return false;
  if (integrationNameWords(integrationName).length > 1) return true;
  return /\p{Ll}\p{Lu}|\p{N}/u.test(integrationName.normalize("NFKC"));
}
