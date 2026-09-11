import { parseDocument } from "yaml";

/** The one interpretation of Skill metadata for imports, writes and migration. */
export function parseSkillFrontmatter(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { name: null, description: null };
  const document = parseDocument(lines.slice(1, end).join("\n"), {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length || document.warnings.length) {
    const issue = document.errors[0] ?? document.warnings[0]!;
    throw new Error(
      `This skill's SKILL.md header contains invalid YAML: ${issue.message}. The source file needs correcting.`,
    );
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 20 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Skill artifact SKILL.md frontmatter must be a mapping");
  const fields = metadata as Record<string, unknown>;
  return {
    name: typeof fields.name === "string" ? fields.name : null,
    description: typeof fields.description === "string" ? fields.description : null,
  };
}

export function readSkillMetadata(markdown: string): { name: string; description: string } {
  const { name, description } = parseSkillFrontmatter(markdown);
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error("Skill artifact SKILL.md must declare a safe name");
  if (!description?.trim() || description.length > 1024)
    throw new Error("Skill artifact SKILL.md must declare a description of 1–1024 characters");
  return { name, description };
}
