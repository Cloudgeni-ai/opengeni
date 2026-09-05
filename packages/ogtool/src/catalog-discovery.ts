import type { AttemptToolCatalog, AttemptToolCatalogEntry } from "@opengeni/codemode";

const DESCRIPTION_MAX_CHARS = 160;

function normalizedDescription(entry: AttemptToolCatalogEntry): string {
  return (entry.description || entry.title || "")
    .split(/\p{White_Space}+/u)
    .filter(Boolean)
    .join(" ");
}

export function shortDescription(entry: AttemptToolCatalogEntry): string {
  const text = normalizedDescription(entry);
  const characters = Array.from(text);
  return characters.length <= DESCRIPTION_MAX_CHARS
    ? text
    : `${characters.slice(0, DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

/** Terminal-only presentation: never mutate catalog, query, or JSON content. */
function terminalDescription(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export type ListOptions = {
  full: boolean;
  json: boolean;
  query: string;
  limit?: number;
  offset: number;
};

export function parseListOptions(args: string[]): ListOptions {
  const options: ListOptions = { full: false, json: false, query: "", offset: 0 };
  const seen = new Set<string>();
  const invalid = () =>
    new Error(
      "usage: ogtool list [--full | --json] [--query <substring>] [--limit <1..100>] [--offset <nonnegative integer>]",
    );
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (seen.has(flag)) throw invalid();
    seen.add(flag);
    if (flag === "--full" || flag === "--json") {
      if (equals >= 0) throw invalid();
      options[flag === "--full" ? "full" : "json"] = true;
    } else if (flag === "--query" || flag === "--limit" || flag === "--offset") {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith("-"))) throw invalid();
      if (flag === "--query") options.query = value;
      else {
        if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
        const number = Number(value);
        if (flag === "--limit" && (number < 1 || number > 100)) throw invalid();
        options[flag === "--limit" ? "limit" : "offset"] = number;
      }
    } else throw invalid();
  }
  if (options.full && seen.size !== 1) throw invalid();
  return options;
}

/** Compact per tool, never truncate the authorized catalog to an output budget. */
export function compactOutput(catalog: AttemptToolCatalog, options: ListOptions): string {
  const matches = catalog.entries.filter(
    (entry) =>
      entry.codemodePath.join(".").includes(options.query) ||
      normalizedDescription(entry).includes(options.query),
  );
  const tools = matches
    .slice(options.offset, options.limit === undefined ? undefined : options.offset + options.limit)
    .map((entry) => ({
      path: entry.codemodePath.join("."),
      description: shortDescription(entry),
    }));
  const textLines = options.json
    ? []
    : tools.map(
        (tool) =>
          `${tool.path}${tool.description ? ` — ${terminalDescription(tool.description)}` : ""}\n`,
      );
  const nextOffset =
    options.offset + tools.length < matches.length ? options.offset + tools.length : null;
  const page = {
    catalogDigest: catalog.digest,
    total: matches.length,
    offset: options.offset,
    nextOffset,
    tools,
  };
  const output = options.json
    ? `${JSON.stringify(page)}\n`
    : textLines.join("") +
      `# total: ${page.total}; offset: ${page.offset}; nextOffset: ${nextOffset ?? "none"}\n` +
      (nextOffset === null
        ? ""
        : `# Continue with --offset ${nextOffset} (keep the same --query and --limit).\n`);
  return output;
}
