/* ----------------------------------------------------------------------------
   Product words for skills and plugins. Registries hand us slugs
   ("vercel-react-best-practices") and model-facing trigger text in the
   SKILL.md frontmatter; people read a name and one plain sentence.
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

/** The SKILL.md body without its YAML frontmatter. */
export function skillBody(markdown: string | null | undefined): string {
  return (markdown ?? "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

/**
 * The first plain paragraph of the SKILL.md body: what the skill is, in the
 * author's words for people. Headings, lists, code and callouts are skipped;
 * null when the body has no prose paragraph.
 */
export function skillSummary(markdown: string | null | undefined): string | null {
  const body = skillBody(markdown).replace(/```[\s\S]*?```/g, "");
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text) continue;
    if (/^(#|[-*+] |\d+\. |>|\||<|!\[)/.test(text)) continue;
    const plain = text
      .replace(/\r?\n/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    if (plain.length < 20) continue;
    return plain.length > 320 ? `${plain.slice(0, 317).trimEnd()}...` : plain;
  }
  return null;
}

export function scopeLabel(scope: "user" | "workspace" | "organization"): string {
  return scope === "user" ? "Personal" : scope === "workspace" ? "Workspace" : "Organization";
}

/** "Only you" / "Everyone in this workspace" / "Everyone in your organization". */
export function scopeAudience(scope: "user" | "workspace" | "organization"): string {
  return scope === "user"
    ? "Only you"
    : scope === "workspace"
      ? "Everyone in this workspace"
      : "Everyone in your organization";
}
