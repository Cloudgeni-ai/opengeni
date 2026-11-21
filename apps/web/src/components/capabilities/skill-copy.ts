/* ----------------------------------------------------------------------------
   Product words for skills and plugins. Registries hand us slugs
   ("vercel-react-best-practices") and model-facing trigger text in the
   SKILL.md frontmatter; people read a name and one plain sentence.
   -------------------------------------------------------------------------- */

/** "agent-browser" -> "Agent browser"; shared with the agent page's Skills. */
export { humanizeName } from "@opengeni/react/app/lib/skill-names";

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
