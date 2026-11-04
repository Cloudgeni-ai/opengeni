import { parseDocument } from "yaml";

/** A SKILL.md header that could not be interpreted. `reason` is a bounded,
 * content-free code (for example `yaml_block_as_implicit_key`), safe to log. */
export class SkillFrontmatterError extends Error {
  override readonly name = "SkillFrontmatterError";
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

function frontmatterBlock(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  return lines.slice(1, end);
}

/** The one interpretation of Skill metadata for imports, writes and migration. */
export function parseSkillFrontmatter(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const block = frontmatterBlock(markdown);
  if (!block) return { name: null, description: null };
  const document = parseDocument(block.join("\n"), {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length || document.warnings.length) {
    const issue = document.errors[0] ?? document.warnings[0]!;
    throw new SkillFrontmatterError(
      `This skill's SKILL.md header contains invalid YAML: ${issue.message}. The source file needs correcting.`,
      /^[A-Z_]{1,40}$/u.test(issue.code) ? `yaml_${issue.code.toLowerCase()}` : "yaml_other",
    );
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 20 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new SkillFrontmatterError(
      "Skill artifact SKILL.md frontmatter must be a mapping",
      "yaml_not_mapping",
    );
  const fields = metadata as Record<string, unknown>;
  return {
    name: typeof fields.name === "string" ? fields.name : null,
    description: typeof fields.description === "string" ? fields.description : null,
  };
}

export type LenientSkillFrontmatter = {
  name: string | null;
  description: string | null;
  /** Set only when strict YAML failed and the line fallback recovered the
   * fields: the bounded strict-parse reason, for diagnostics. */
  fallbackReason?: string;
  /** Top-level key names the fallback saw (bounded; never values). */
  keys?: string[];
};

const FALLBACK_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/u;
const BLOCK_SCALAR = /^([|>])[+-]?[1-9]?[+-]?(?:[ \t]+#.*)?$/u;
const MAX_FALLBACK_KEYS = 32;

/**
 * Read repository-provided Skill metadata the way people actually write it.
 * Strict YAML (the portable interpretation above) wins whenever it parses.
 * When it does not, a line scan recovers top-level `name` and `description`
 * from common hand-written mistakes: unquoted `: ` inside a description,
 * tab indentation, unindented continuation lines, values that start with a
 * YAML indicator (`[`, `*`, `@`, `` ` ``, `%`, `!`, `-`, `{`), or a quoted
 * prefix followed by more text. Unknown keys are ignored.
 *
 * The fallback never invents a name: it requires exactly one top-level
 * `name:` line with a value, and throws `SkillFrontmatterError` otherwise.
 * Managed and explicit Skill admission keep using the strict parser.
 */
export function parseLenientSkillFrontmatter(markdown: string): LenientSkillFrontmatter {
  let strictReason: string;
  try {
    return parseSkillFrontmatter(markdown);
  } catch (error) {
    strictReason = error instanceof SkillFrontmatterError ? error.reason : "yaml_other";
  }
  const fields = new Map<string, Array<{ lines: string[]; mode: "plain" | "|" | ">" }>>();
  const keys: string[] = [];
  let current: { lines: string[]; mode: "plain" | "|" | ">" } | null = null;
  for (const line of frontmatterBlock(markdown) ?? []) {
    const key = FALLBACK_KEY.exec(line);
    if (key) {
      const name = key[1]!;
      if (keys.length < MAX_FALLBACK_KEYS && !keys.includes(name)) keys.push(name);
      const raw = (key[2] ?? "").trim();
      const blockScalar = BLOCK_SCALAR.exec(raw);
      current = blockScalar
        ? { lines: [], mode: blockScalar[1] as "|" | ">" }
        : { lines: raw ? [raw] : [], mode: "plain" };
      fields.set(name, [...(fields.get(name) ?? []), current]);
      continue;
    }
    // Anything else continues the open value: indented (spaces or tabs),
    // unindented prose, or a blank line inside a block scalar.
    current?.lines.push(line);
  }
  const names = fields.get("name") ?? [];
  if (names.length > 1)
    throw new SkillFrontmatterError("SKILL.md declares more than one name", "duplicate_name");
  // A name is one line; stray text after it never becomes part of the name.
  const nameLine = names[0]?.lines.find((line) => line.trim());
  const name = nameLine ? unquoteFallbackValue(stripFallbackComment(nameLine.trim())) : "";
  if (!name)
    throw new SkillFrontmatterError(
      "SKILL.md header is not valid YAML and no name could be read from it",
      `${strictReason}_without_name`,
    );
  const description = fields.get("description")?.[0];
  const descriptionText = description
    ? unquoteFallbackValue(foldFallbackValue(description.lines, description.mode))
    : "";
  return {
    name,
    description: descriptionText || null,
    fallbackReason: strictReason,
    keys,
  };
}

function foldFallbackValue(lines: readonly string[], mode: "plain" | "|" | ">"): string {
  const trimmedEnd = [...lines];
  while (trimmedEnd.length && !trimmedEnd.at(-1)!.trim()) trimmedEnd.pop();
  if (mode === "|") {
    const indent = Math.min(
      ...trimmedEnd.filter((line) => line.trim()).map((line) => /^[ \t]*/u.exec(line)![0].length),
    );
    return trimmedEnd
      .map((line) => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd())
      .join("\n")
      .trim();
  }
  // Plain and folded text: lines join with spaces, blank lines keep paragraphs.
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  for (const line of trimmedEnd) {
    if (line.trim()) paragraph.push(line.trim());
    else if (paragraph.length) {
      paragraphs.push(paragraph.join(" "));
      paragraph = [];
    }
  }
  if (paragraph.length) paragraphs.push(paragraph.join(" "));
  return paragraphs.join("\n");
}

function stripFallbackComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  return value.replace(/[ \t]+#.*$/u, "").trim();
}

function unquoteFallbackValue(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
    return text
      .slice(1, -1)
      .replace(/\\(["\\])/gu, "$1")
      .trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1).replace(/''/gu, "'").trim();
  return text;
}

export function readSkillMetadata(markdown: string): { name: string; description: string } {
  const { name, description } = parseSkillFrontmatter(markdown);
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error("Skill artifact SKILL.md must declare a safe name");
  if (!description?.trim() || description.length > 1024)
    throw new Error("Skill artifact SKILL.md must declare a description of 1–1024 characters");
  return { name, description };
}
