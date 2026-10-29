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

export const SKILL_CATALOG_MAX_BYTES = 32 * 1024;
export const SKILL_CATALOG_MAX_ENTRIES = 128;
/** Largest instructions one entry may show in full, in UTF-8 bytes. */
export const SKILL_CATALOG_INLINE_MAX_BYTES = 1024;
/** Largest total of instructions shown in full across the index, in UTF-8 bytes. */
export const SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES = 4096;

const INLINE_NOTICE =
  "Entries with an instructions field show that Skill's complete instructions: follow them whenever the description applies, without skill_read.";

/**
 * The SKILL.md body without its frontmatter, as the index shows it in full.
 * Null when the remaining text is empty.
 */
export function skillInstructionsBody(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/u);
  let body = markdown;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end !== -1) body = lines.slice(end + 1).join("\n");
  }
  const trimmed = body.trim();
  return trimmed ? trimmed : null;
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
  // listed first so the entry bounds below can never omit them.
  const inline = new Map<string, string>();
  let inlineBytes = 0;
  for (const entry of sorted) {
    const text = entry.instructions?.trim();
    if (!text) continue;
    const size = Buffer.byteLength(text, "utf8");
    if (size > SKILL_CATALOG_INLINE_MAX_BYTES) continue;
    if (inlineBytes + size > SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES) continue;
    inline.set(entry.id, text);
    inlineBytes += size;
  }
  const ordered = [
    ...sorted.filter((entry) => inline.has(entry.id)),
    ...sorted.filter((entry) => !inline.has(entry.id)),
  ];
  const header = [
    "## Skills",
    "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
    byId.has("builtin:skill-management")
      ? "For finding, installing, creating, or editing Skills, read the skill-management Skill. Management tools are lazy and available through tool search."
      : "Management tools are lazy and available through tool search.",
    "The following entries are descriptors, not the Skill instructions. Use the id when names are ambiguous.",
    ...(inline.size > 0 ? [INLINE_NOTICE] : []),
  ].join("\n");
  const lines = [header];
  if (ordered.length === 0) lines.push("No configured Skills are currently available.");
  let bytes = Buffer.byteLength(header, "utf8");
  let included = 0;
  for (const entry of ordered) {
    const instructions = inline.get(entry.id);
    const line = `- ${JSON.stringify({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      ...(instructions !== undefined ? { instructions } : {}),
    })}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    // Reserve the short omission notice rather than silently overrun the bound.
    if (included >= SKILL_CATALOG_MAX_ENTRIES || bytes + lineBytes > SKILL_CATALOG_MAX_BYTES - 256)
      continue;
    lines.push(line);
    bytes += lineBytes;
    included += 1;
  }
  const omitted = ordered.length - included;
  if (omitted > 0)
    lines.push(
      `${omitted} additional Skills are omitted from this short index. Use skill_search to find them.`,
    );
  return lines.join("\n");
}

/**
 * Ids of the entries a rendered catalog lists. Entries omitted by the bounds
 * above are not listed, so they are not in the set; header and notice lines
 * are never entries.
 */
export function skillCatalogEntryIds(catalog: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of catalog.split("\n")) {
    if (!line.startsWith("- {")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line.slice(2));
    } catch {
      continue;
    }
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}
