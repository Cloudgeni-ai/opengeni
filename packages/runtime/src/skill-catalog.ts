export type SkillCatalogDescriptor = Readonly<{
  id: string;
  name: string;
  description: string;
  /**
   * The Skill's complete instructions (SKILL.md without its frontmatter), for
   * a short single-file Skill the index may show in full so the model can
   * follow it without a skill_read round trip. Shown only within the inline
   * bounds below; otherwise the entry stays a descriptor.
   */
  instructions?: string | undefined;
}>;

/**
 * Bound on the rendered index. A Skill's index entry is the only way the
 * agent learns it exists, so the bound is sized to list every Skill of a
 * large workspace (several hundred at typical description lengths) and only
 * protects the context window from runaway catalogs.
 */
export const SKILL_CATALOG_MAX_BYTES = 96 * 1024;
/**
 * Largest instructions one entry may show in full, in UTF-8 bytes of the
 * rendered (JSON-escaped) text, so escapes count as the index shows them.
 */
export const SKILL_CATALOG_INLINE_MAX_BYTES = 1024;
/** Largest total of rendered instructions shown in full across the index, in UTF-8 bytes. */
export const SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES = 4096;
const SHORTENED = "…";

type IndexEntry = {
  id: string;
  name: string;
  description: string;
  showId: boolean;
  instructions: string | undefined;
};

function entryLine(entry: IndexEntry, description: string): string {
  return `- ${JSON.stringify({
    ...(entry.showId ? { id: entry.id } : {}),
    name: entry.name,
    description,
    ...(entry.instructions !== undefined ? { instructions: entry.instructions } : {}),
  })}`;
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

const READ_BY_NAME =
  "Read a Skill by its name; an entry shows an id only when several Skills share that name, and then you read it by that id.";
const DESCRIPTOR_NOTICE = `The following entries are descriptors, not the Skill instructions. ${READ_BY_NAME}`;
/** Replaces the descriptor notice only when some entry is shown in full. */
const DESCRIPTOR_AND_INLINE_NOTICE = `The following entries are descriptors, except that an instructions field holds that Skill's complete instructions: follow them whenever its description applies, without skill_read. ${READ_BY_NAME}`;

/**
 * The SKILL.md body without its frontmatter, as the index shows it in full.
 * Line endings are normalised the same way with or without frontmatter. Null
 * when the remaining text is empty or the frontmatter has no closing line.
 */
export function skillInstructionsBody(markdown: string): string | null {
  const lines = markdown.split(/\r\n?|\n/u);
  let body = lines.join("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end === -1) return null;
    body = lines.slice(end + 1).join("\n");
  }
  const trimmed = body.trim();
  return trimmed ? trimmed : null;
}

/** UTF-8 bytes of a string as the index renders it inside a JSON string. */
function renderedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Descriptors, plus the complete instructions of short Skills whose caller
 * supplied them within the inline bounds; other file bodies and complete path
 * inventories are read on demand. A catalog without such entries renders
 * exactly as a descriptor-only catalog.
 */
export function formatSkillCatalog(descriptors: readonly SkillCatalogDescriptor[]): string {
  const byId = new Map<string, SkillCatalogDescriptor>();
  for (const entry of descriptors) {
    if (!entry.id || !entry.name || !entry.description)
      throw new Error("Invalid Skill catalog descriptor.");
    const prior = byId.get(entry.id);
    if (
      prior &&
      (prior.name !== entry.name ||
        prior.description !== entry.description ||
        (prior.instructions ?? null) !== (entry.instructions ?? null))
    ) {
      throw new Error(`Conflicting Skill catalog identity: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  const sorted = [...byId.values()].sort((a, b) => {
    if (a.id === "builtin:skill-management") return -1;
    if (b.id === "builtin:skill-management") return 1;
    const left = `${a.name}\u0000${a.id}`;
    const right = `${b.name}\u0000${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  // Choose shown-in-full entries in index order within both bounds. They are
  // listed first so that, if even names alone overrun the index bound, they
  // are the last entries to be omitted.
  const inline = new Map<string, string>();
  let inlineBytes = 0;
  for (const entry of sorted) {
    const text = entry.instructions?.trim();
    if (!text) continue;
    const size = renderedBytes(text);
    if (size > SKILL_CATALOG_INLINE_MAX_BYTES) continue;
    if (inlineBytes + size > SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES) continue;
    inline.set(entry.id, text);
    inlineBytes += size;
  }
  const ordered = [
    ...sorted.filter((entry) => inline.has(entry.id)),
    ...sorted.filter((entry) => !inline.has(entry.id)),
  ];
  const nameCounts = new Map<string, number>();
  for (const entry of ordered) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  const entries: IndexEntry[] = ordered.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    showId: (nameCounts.get(entry.name) ?? 0) > 1,
    instructions: inline.get(entry.id),
  }));
  const headerWith = (notice: string): string =>
    [
      "## Skills",
      "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
      byId.has("builtin:skill-management")
        ? "For finding, installing, creating, or editing Skills, read the skill-management Skill. Management tools are lazy and available through tool search."
        : "Management tools are lazy and available through tool search.",
      notice,
    ].join("\n");
  const header = headerWith(inline.size > 0 ? DESCRIPTOR_AND_INLINE_NOTICE : DESCRIPTOR_NOTICE);
  if (entries.length === 0)
    return [header, "No configured Skills are currently available."].join("\n");
  // Reserve room for the short notice rather than silently overrun the bound.
  const budget = SKILL_CATALOG_MAX_BYTES - Buffer.byteLength(header, "utf8") - 256;
  const longest = Math.max(...entries.map((entry) => Array.from(entry.description).length));
  const complete = linesWithin(entries, longest);
  if (bytesOf(complete) <= budget) return [header, ...complete].join("\n");
  // Too large to list in full: every Skill stays listed by name, and only the
  // longest descriptions are shortened, to the largest common length that
  // fits. Instructions shown in full are never shortened; they are bounded above.
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
  // Names alone exceed the bound; list as many as fit and say how many are
  // left. No instructions are shown in this mode, so the notice says so.
  const lines = [headerWith(DESCRIPTOR_NOTICE)];
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
