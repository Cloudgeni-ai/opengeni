export type SkillCatalogDescriptor = Readonly<{
  id: string;
  name: string;
  description: string;
}>;

/**
 * Bound on the rendered index. A Skill's index entry is the only way the
 * agent learns it exists, so the bound is sized to list every Skill of a
 * large workspace (several hundred at typical description lengths) and only
 * protects the context window from runaway catalogs.
 */
export const SKILL_CATALOG_MAX_BYTES = 96 * 1024;
const SHORTENED = "…";

type IndexEntry = { id: string; name: string; description: string; showId: boolean };

function entryLine(entry: IndexEntry, description: string): string {
  return `- ${JSON.stringify(
    entry.showId
      ? { id: entry.id, name: entry.name, description }
      : { name: entry.name, description },
  )}`;
}

function shorten(description: string, limit: number): string {
  const chars = Array.from(description);
  return chars.length <= limit ? description : `${chars.slice(0, limit).join("")}${SHORTENED}`;
}

function linesWithin(entries: readonly IndexEntry[], limit: number): string[] {
  return entries.map((entry) => entryLine(entry, shorten(entry.description, limit)));
}

function bytesOf(lines: readonly string[]): number {
  let bytes = 0;
  for (const line of lines) bytes += Buffer.byteLength(line, "utf8") + 1;
  return bytes;
}

/** Descriptors only; file bodies and complete path inventories are read on demand. */
export function formatSkillCatalog(descriptors: readonly SkillCatalogDescriptor[]): string {
  const byId = new Map<string, SkillCatalogDescriptor>();
  for (const entry of descriptors) {
    if (!entry.id || !entry.name || !entry.description)
      throw new Error("Invalid Skill catalog descriptor.");
    const prior = byId.get(entry.id);
    if (prior && (prior.name !== entry.name || prior.description !== entry.description)) {
      throw new Error(`Conflicting Skill catalog identity: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.id === "builtin:skill-management") return -1;
    if (b.id === "builtin:skill-management") return 1;
    const left = `${a.name}\u0000${a.id}`;
    const right = `${b.name}\u0000${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const nameCounts = new Map<string, number>();
  for (const entry of ordered) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  const entries: IndexEntry[] = ordered.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    showId: (nameCounts.get(entry.name) ?? 0) > 1,
  }));
  const header = [
    "## Skills",
    "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
    byId.has("builtin:skill-management")
      ? "For finding, installing, creating, or editing Skills, read the skill-management Skill. Management tools are lazy and available through tool search."
      : "Management tools are lazy and available through tool search.",
    "The following entries are descriptors, not the Skill instructions. Read a Skill by its name; an entry shows an id only when several Skills share that name, and then you read it by that id.",
  ].join("\n");
  if (entries.length === 0)
    return [header, "No configured Skills are currently available."].join("\n");
  // Reserve room for the short notice rather than silently overrun the bound.
  const budget = SKILL_CATALOG_MAX_BYTES - Buffer.byteLength(header, "utf8") - 256;
  const longest = Math.max(...entries.map((entry) => Array.from(entry.description).length));
  const complete = linesWithin(entries, longest);
  if (bytesOf(complete) <= budget) return [header, ...complete].join("\n");
  // Too large to list in full: every Skill stays listed by name, and only the
  // longest descriptions are shortened, to the largest common length that fits.
  let low = 0;
  let high = longest;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytesOf(linesWithin(entries, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  const shortened = linesWithin(entries, low);
  if (bytesOf(shortened) <= budget)
    return [
      header,
      ...shortened,
      "Some descriptions above are shortened to fit; skill_search shows them in full.",
    ].join("\n");
  // Names alone exceed the bound; list as many as fit and say how many are left.
  const lines = [header];
  let bytes = 0;
  let included = 0;
  for (const entry of entries) {
    const line = `- ${JSON.stringify(entry.showId ? { id: entry.id, name: entry.name } : { name: entry.name })}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > budget) break;
    lines.push(line);
    bytes += lineBytes;
    included += 1;
  }
  lines.push(
    `${entries.length - included} additional Skills are omitted from this index. Use skill_search to find them.`,
  );
  return lines.join("\n");
}

/**
 * Ids of the entries a rendered catalog lists. An entry names its id only when
 * its name is shared; other entries resolve through the descriptors the
 * catalog was rendered from. Entries omitted by the bound above are not
 * listed, so they are not in the set; header and notice lines are never
 * entries.
 */
export function skillCatalogEntryIds(
  catalog: string,
  descriptors: readonly SkillCatalogDescriptor[] = [],
): ReadonlySet<string> {
  const idsByName = new Map<string, string[]>();
  for (const descriptor of descriptors) {
    const ids = idsByName.get(descriptor.name) ?? [];
    if (!ids.includes(descriptor.id)) ids.push(descriptor.id);
    idsByName.set(descriptor.name, ids);
  }
  const ids = new Set<string>();
  for (const line of catalog.split("\n")) {
    if (!line.startsWith("- {")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line.slice(2));
    } catch {
      continue;
    }
    const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
    if (typeof id === "string" && id) ids.add(id);
    else if (typeof name === "string") {
      const named = idsByName.get(name);
      if (named?.length === 1) ids.add(named[0]!);
    }
  }
  return ids;
}
