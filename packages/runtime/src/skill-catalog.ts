export type SkillCatalogDescriptor = Readonly<{
  id: string;
  name: string;
  description: string;
}>;

export const SKILL_CATALOG_MAX_BYTES = 32 * 1024;
export const SKILL_CATALOG_MAX_ENTRIES = 128;

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
    if (a.id === "builtin:opengeni-skills") return -1;
    if (b.id === "builtin:opengeni-skills") return 1;
    const left = `${a.name}\u0000${a.id}`;
    const right = `${b.name}\u0000${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const header = [
    "## Skills",
    "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
    byId.has("builtin:opengeni-skills")
      ? "For finding, installing, creating, or editing Skills, read opengeni-skills. Management tools are lazy and available through tool search."
      : "Management tools are lazy and available through tool search.",
    "The following entries are descriptors, not the Skill instructions. Use the id when names are ambiguous.",
  ].join("\n");
  const lines = [header];
  let bytes = Buffer.byteLength(header, "utf8");
  let included = 0;
  for (const entry of ordered) {
    const line = `- ${JSON.stringify({ id: entry.id, name: entry.name, description: entry.description })}`;
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
