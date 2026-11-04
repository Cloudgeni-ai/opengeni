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
  type FallbackValue = { inline: string; lines: string[]; mode: "plain" | "|" | ">" };
  const fields = new Map<string, FallbackValue[]>();
  const keys: string[] = [];
  let current: FallbackValue | null = null;
  for (const line of frontmatterBlock(markdown) ?? []) {
    const key = FALLBACK_KEY.exec(line);
    if (key) {
      const name = key[1]!;
      if (keys.length < MAX_FALLBACK_KEYS && !keys.includes(name)) keys.push(name);
      const raw = (key[2] ?? "").trim();
      const blockScalar = BLOCK_SCALAR.exec(raw);
      current = blockScalar
        ? { inline: "", lines: [], mode: blockScalar[1] as "|" | ">" }
        : { inline: raw, lines: [], mode: "plain" };
      const values = fields.get(name);
      if (values) values.push(current);
      else fields.set(name, [current]);
      continue;
    }
    // Comments never become part of a value: any `#` line in plain text, and
    // a column-0 `#` line inside a block scalar (indented `#` is block text).
    if (current?.mode === "plain" ? /^[ \t]*#/u.test(line) : line.startsWith("#")) continue;
    // Anything else continues the open value: indented (spaces or tabs),
    // unindented prose, or a blank line inside a block scalar.
    current?.lines.push(line);
  }
  const names = fields.get("name") ?? [];
  if (names.length > 1)
    throw new SkillFrontmatterError("SKILL.md declares more than one name", "duplicate_name");
  const name = fallbackName(names[0]);
  if (!name)
    throw new SkillFrontmatterError(
      "SKILL.md header is not valid YAML and no name could be read from it",
      `${strictReason}_without_name`,
    );
  const description = fields.get("description")?.[0];
  const descriptionText = description
    ? unquoteFallbackValue(
        foldFallbackValue(
          description.inline ? [description.inline, ...description.lines] : description.lines,
          description.mode,
        ),
      )
    : "";
  return {
    name,
    description: descriptionText || null,
    fallbackReason: strictReason,
    keys,
  };
}

// Unquoted YAML core-schema scalars that are not strings. Strict YAML never
// reads these as a name, so the fallback must not either.
const NON_STRING_SCALAR =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/u;

/** A name is one line: the inline value, or the first indented line of a
 * block or continuation. Unindented stray text after an empty `name:` is
 * never borrowed as the name. */
function fallbackName(value: { inline: string; lines: string[]; mode: string } | undefined) {
  if (!value) return "";
  const raw = value.inline || value.lines.find((line) => /^[ \t]+\S/u.test(line))?.trim() || "";
  const text = stripFallbackComment(raw);
  if (value.mode === "plain" && NON_STRING_SCALAR.test(text)) return "";
  return unquoteFallbackValue(text);
}

function foldFallbackValue(lines: readonly string[], mode: "plain" | "|" | ">"): string {
  const trimmedEnd = [...lines];
  while (trimmedEnd.length && !trimmedEnd.at(-1)!.trim()) trimmedEnd.pop();
  if (mode === "|") {
    let indent = Number.POSITIVE_INFINITY;
    for (const line of trimmedEnd)
      if (line.trim()) indent = Math.min(indent, /^[ \t]*/u.exec(line)![0].length);
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

/** Index of the quote closing a value that opens with `"` or `'`, or -1. */
function closingQuoteIndex(text: string): number {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === "\\") index += 1;
    else if (char === quote) {
      if (quote === "'" && text[index + 1] === "'") index += 1;
      else return index;
    }
  }
  return -1;
}

function stripFallbackComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    const close = closingQuoteIndex(value);
    return close > 0 && /^[ \t]+#/u.test(value.slice(close + 1))
      ? value.slice(0, close + 1)
      : value;
  }
  return value.replace(/[ \t]+#.*$/u, "").trim();
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  "0": "\0",
  t: "\t",
  n: "\n",
  r: "\r",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
};

/** Unquote only a value that is exactly one quoted scalar; anything with
 * more text after the closing quote stays as written. */
function unquoteFallbackValue(value: string): string {
  const text = value.trim();
  if (
    !(text.startsWith('"') || text.startsWith("'")) ||
    closingQuoteIndex(text) !== text.length - 1
  )
    return text;
  const body = text.slice(1, -1);
  if (text[0] === "'") return body.replace(/''/gu, "'").trim();
  return body
    .replace(/\\(.)/gu, (escape, char: string) => DOUBLE_QUOTED_ESCAPES[char] ?? escape)
    .trim();
}

export function readSkillMetadata(markdown: string): { name: string; description: string } {
  const { name, description } = parseSkillFrontmatter(markdown);
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error("Skill artifact SKILL.md must declare a safe name");
  if (!description?.trim() || description.length > 1024)
    throw new Error("Skill artifact SKILL.md must declare a description of 1–1024 characters");
  return { name, description };
}
