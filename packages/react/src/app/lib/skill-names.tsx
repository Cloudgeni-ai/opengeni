import { parseDocument } from "yaml";

/* ----------------------------------------------------------------------------
   How people read a Skill's name. Registries and SKILL.md frontmatter hand us
   slugs ("vercel-react-best-practices"); a Skill written in Opengeni without a
   name keeps a generated `authored-<id>` key, which is never shown. The
   frontmatter's trigger text is for agents; people read a name and one plain
   sentence from the body.
   -------------------------------------------------------------------------- */

const SMALL_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
const FRONTMATTER = /^\uFEFF?---\r?\n((?:[^\n]*\n)*?)---[ \t]*(?:\r?\n|$)/;

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

/** Display metadata only: a title is distinct from the Skill's stable name. */
export function skillReadLabels(markdown: string): { title: string | null; name: string | null } {
  const header = FRONTMATTER.exec(markdown);
  const doc = header ? parseDocument(header[1]!) : null;
  const field = (key: "title" | "name") => {
    const value = doc?.errors.length === 0 ? doc.get(key) : undefined;
    return typeof value === "string" ? value.trim() || null : null;
  };
  const body = header ? markdown.slice(header[0].length) : markdown.replace(/^\uFEFF/, "");
  return { title: field("title") ?? firstSkillHeading(body), name: field("name") };
}

function firstSkillHeading(body: string): string | null {
  let fence = "";
  let previous = "";
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1]!;
      previous = "";
      continue;
    }
    const atx = /^ {0,3}#[ \t]+(.+)$/
      .exec(line)?.[1]
      ?.replace(/[ \t]+#+[ \t]*$/, "")
      .trim();
    if (atx) return atx;
    if (/^ {0,3}=+[ \t]*$/.test(line) && previous) return previous;
    previous = /^ {0,3}[^\s#>]/.test(line) ? line.trim() : "";
  }
  return null;
}

/** The first sentence of a Skill's description, for one line in a list. */
export function skillShortDescription(description: string | null | undefined): string | null {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}

/** The SKILL.md body without its YAML frontmatter. */
export function skillBody(markdown: string | null | undefined): string {
  return (markdown ?? "").replace(FRONTMATTER, "").trim();
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
