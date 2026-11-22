/* ----------------------------------------------------------------------------
   How people read a Skill's name. Registries and SKILL.md frontmatter hand us
   slugs ("vercel-react-best-practices"); a Skill written in Opengeni without a
   name keeps a generated `authored-<id>` key, which is never shown.
   -------------------------------------------------------------------------- */

const SMALL_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** "agent-browser" -> "Agent browser". Names that already read as names are kept. */
export function humanizeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  // Already written for people: has a space or an uppercase letter past the first.
  if (/\s/.test(trimmed) || /[A-Z]/.test(trimmed.slice(1))) return trimmed;
  const words = trimmed.split(/[-_.]+/).filter(Boolean);
  if (!words.length) return trimmed;
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : SMALL_WORDS.has(word)
          ? word
          : word.toLowerCase(),
    )
    .join(" ");
}

/** A key Opengeni generated for a Skill written without a name. */
export function isGeneratedSkillKey(key: string): boolean {
  return /^authored-[0-9a-f]{32}$/i.test(key.trim());
}

/** A Skill's name for people: its title, else its key unless generated. */
export function skillDisplayName(skill: { title: string | null; stableKey: string }): string {
  const raw = skill.title?.trim() || (isGeneratedSkillKey(skill.stableKey) ? "" : skill.stableKey);
  return humanizeName(raw) || "Untitled Skill";
}

/** The first sentence of a Skill's description, for one line in a list. */
export function skillShortDescription(description: string | null | undefined): string | null {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}
