import type { AttemptToolCatalog, AttemptToolCatalogEntry } from "@opengeni/contracts";

/**
 * Resolve the name an agent uses to ask for a Codemode tool.
 *
 * Accepted, most specific first:
 * 1. the exact path (`mail.send_message`), model name, or `serverId.tool`;
 * 2. the namespace or server with the tool's own name, joined by `.` or `__`
 *    (`mail.send-message`, `mail__send_message`);
 * 3. the tool's own name alone (`send_message`), when one tool has it.
 *
 * The first level with any match decides. Several matches there is an
 * ambiguity that lists their paths; no match suggests the closest names.
 *
 * Levels 1 and 2 name the tool's identity: its server (whose namespace
 * carries a tag of the connected account) and its tool. A plain name does
 * not, and could mean another account's tool in a later turn, so a call
 * (allowPlainName false) never resolves one: it is told the path instead.
 */
export type CatalogToolResolution =
  | { readonly entry: AttemptToolCatalogEntry }
  | {
      readonly error: "unknown" | "ambiguous" | "needs_path";
      readonly reference: string;
      readonly candidates: readonly string[];
    };

export function resolveCatalogTool(
  catalog: Pick<AttemptToolCatalog, "entries">,
  reference: string,
  options: { readonly allowPlainName?: boolean } = {},
): CatalogToolResolution {
  const levels: ReadonlyArray<(entry: AttemptToolCatalogEntry) => boolean> = [
    (entry) =>
      entry.codemodePath.join(".") === reference ||
      entry.modelName === reference ||
      `${entry.identity.serverId}.${entry.identity.toolName}` === reference,
    (entry) =>
      [entry.codemodePath[0], entry.identity.serverId].some(
        (prefix) =>
          `${prefix}.${entry.identity.toolName}` === reference ||
          `${prefix}__${entry.identity.toolName}` === reference,
      ),
    ...(options.allowPlainName === false
      ? []
      : [(entry: AttemptToolCatalogEntry) => plainNameMatches(entry, reference)]),
  ];
  for (const matches of levels) {
    const found = catalog.entries.filter(matches);
    if (found.length === 1) return { entry: found[0]! };
    if (found.length > 1) {
      return {
        error: "ambiguous",
        reference,
        candidates: found.map((entry) => entry.codemodePath.join(".")).sort(),
      };
    }
  }
  if (options.allowPlainName === false) {
    const named = catalog.entries.filter((entry) => plainNameMatches(entry, reference));
    if (named.length > 0) {
      return {
        error: "needs_path",
        reference,
        candidates: named.map((entry) => entry.codemodePath.join(".")).sort(),
      };
    }
  }
  return { error: "unknown", reference, candidates: closestCatalogTools(catalog, reference) };
}

function plainNameMatches(entry: AttemptToolCatalogEntry, reference: string): boolean {
  return entry.identity.toolName === reference || entry.codemodePath.at(-1) === reference;
}

/** A one-line explanation of a failed resolution, naming what to use instead. */
export function catalogToolResolutionMessage(
  resolution: Exclude<CatalogToolResolution, { entry: AttemptToolCatalogEntry }>,
): string {
  if (resolution.error === "ambiguous") {
    return `Ambiguous tool: ${resolution.reference} matches ${resolution.candidates.join(", ")}. Use one of these paths.`;
  }
  if (resolution.error === "needs_path") {
    return `Call a tool by its path, not its own name alone: ${resolution.candidates.join(", ")}.`;
  }
  return resolution.candidates.length
    ? `Unknown Codemode tool: ${resolution.reference}. Closest: ${resolution.candidates.join(", ")}.`
    : `Unknown Codemode tool: ${resolution.reference}`;
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function closestCatalogTools(
  catalog: Pick<AttemptToolCatalog, "entries">,
  reference: string,
  limit = 5,
): string[] {
  const wanted = new Set(words(reference));
  if (wanted.size === 0) return [];
  return catalog.entries
    .map((entry) => {
      const path = entry.codemodePath.join(".");
      const have = new Set(words(`${path} ${entry.identity.toolName}`));
      let score = 0;
      for (const word of wanted) if (have.has(word)) score += 1;
      return { path, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((candidate) => candidate.path);
}
