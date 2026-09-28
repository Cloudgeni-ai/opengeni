/**
 * Sandbox-independent file operations on an already-authorized Skill folder.
 * Callers resolve workspace authority and current content before entering here.
 * These helpers neither activate guidance nor perform persistence.
 */
export type SkillTextFile = Readonly<{ path: string; content: string }>;

export const SKILL_READ_MAX_OUTPUT_BYTES = 512 * 1024;
export const SKILL_READ_MAX_PATHS = 128;

export class SkillFileError extends Error {
  constructor(
    readonly code: "invalid_path" | "invalid_request" | "missing_file" | "output_too_large",
    message: string,
  ) {
    super(message);
    this.name = "SkillFileError";
  }
}

export function assertSkillRelativePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.includes(":") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new SkillFileError("invalid_path", `Expected a safe relative Skill path: ${path}`);
  }
}

/** Inventory shares the reader's path validation and never includes file bodies. */
export function listSkillPaths(
  files: readonly SkillTextFile[],
  maxFiles: number,
): { paths: string[] } {
  if (files.length > maxFiles)
    throw new SkillFileError("output_too_large", `Skill inventory exceeds ${maxFiles} files.`);
  const seen = new Set<string>();
  for (const { path } of files) {
    assertSkillRelativePath(path);
    if (seen.has(path))
      throw new SkillFileError("invalid_request", `Duplicate stored Skill path: ${path}`);
    seen.add(path);
  }
  const result = { paths: [...seen].sort() };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SKILL_READ_MAX_OUTPUT_BYTES)
    throw new SkillFileError("output_too_large", "Skill inventory exceeds the read output limit.");
  return result;
}

/** Omitted paths default to the entry point; explicit paths are never expanded. */
export function readSkillFiles(
  files: readonly SkillTextFile[],
  paths?: readonly string[],
): { files: SkillTextFile[] } {
  const requested = paths ?? ["SKILL.md"];
  if (requested.length === 0 || requested.length > SKILL_READ_MAX_PATHS) {
    throw new SkillFileError(
      "invalid_request",
      `Request between 1 and ${SKILL_READ_MAX_PATHS} paths, or omit paths for SKILL.md.`,
    );
  }
  const byPath = new Map<string, SkillTextFile>();
  for (const file of files) {
    assertSkillRelativePath(file.path);
    if (byPath.has(file.path)) {
      throw new SkillFileError("invalid_request", `Duplicate stored Skill path: ${file.path}`);
    }
    byPath.set(file.path, file);
  }
  const seen = new Set<string>();
  const selected = requested.map((path) => {
    assertSkillRelativePath(path);
    if (seen.has(path)) {
      throw new SkillFileError("invalid_request", `Duplicate requested Skill path: ${path}`);
    }
    seen.add(path);
    const file = byPath.get(path);
    if (!file) throw new SkillFileError("missing_file", `Skill file not found: ${path}`);
    return { path: file.path, content: file.content };
  });
  const result = { files: selected };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SKILL_READ_MAX_OUTPUT_BYTES) {
    throw new SkillFileError(
      "output_too_large",
      "Requested Skill files exceed the read output limit. Request fewer paths or use checkout.",
    );
  }
  return result;
}

export const SKILL_SCRIPT_INDEX_MAX_ENTRIES = 32;
export const SKILL_SCRIPT_INDEX_MAX_BYTES = 4 * 1024;
export const SKILL_SCRIPT_USAGE_MAX_CHARS = 160;
const SCRIPT_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "js",
  "lua",
  "mjs",
  "mts",
  "php",
  "pl",
  "ps1",
  "py",
  "r",
  "rb",
  "sh",
  "ts",
  "zsh",
]);
const SCRIPT_DIRECTORIES = new Set(["bin", "scripts"]);
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "rst", "txt"]);
// Tool pragmas and encoding lines describe the file, not how to run it.
const PRAGMA =
  /^(-\*-|vim?:|eslint|prettier|@ts-|pylint|noqa|type:|shellcheck|mypy|flake8|fmt:|isort)/i;

export type SkillScriptIndexEntry = { path: string; usage?: string };

/**
 * A bounded index of runnable files, derived from content the caller may
 * already read: each script's path and its first usage line (or first comment
 * line when none says "usage"). It lets an agent see a Skill's commands
 * without a sandbox checkout. Returns null when the Skill has no scripts.
 */
export function skillScriptIndex(
  files: readonly SkillTextFile[],
): { scripts: SkillScriptIndexEntry[]; scriptsOmitted?: number } | null {
  const candidates = files
    .filter((file) => file.path !== "SKILL.md" && isSkillScript(file))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (candidates.length === 0) return null;
  const scripts: SkillScriptIndexEntry[] = [];
  let bytes = 0;
  for (const file of candidates) {
    const usage = scriptUsageLine(file.content);
    const entry: SkillScriptIndexEntry = usage ? { path: file.path, usage } : { path: file.path };
    const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
    if (
      scripts.length >= SKILL_SCRIPT_INDEX_MAX_ENTRIES ||
      bytes + entryBytes > SKILL_SCRIPT_INDEX_MAX_BYTES
    )
      break;
    scripts.push(entry);
    bytes += entryBytes;
  }
  const omitted = candidates.length - scripts.length;
  return omitted > 0 ? { scripts, scriptsOmitted: omitted } : { scripts };
}

function isSkillScript(file: SkillTextFile): boolean {
  if (file.content.startsWith("#!")) return true;
  const name = file.path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (SCRIPT_EXTENSIONS.has(extension)) return true;
  const top = file.path.split("/")[0] ?? "";
  return (
    file.path.includes("/") && SCRIPT_DIRECTORIES.has(top) && !DOCUMENT_EXTENSIONS.has(extension)
  );
}

function scriptUsageLine(content: string): string | undefined {
  const lines = content.split(/\r?\n/u, 80);
  let firstComment: string | undefined;
  let codeUsage: string | undefined;
  // The closing marker of an open docstring or block comment.
  let closer: string | null = null;
  for (const [index, raw] of lines.entries()) {
    if (index === 0 && raw.startsWith("#!")) continue;
    let line = raw.trim();
    let text: string | null = null;
    if (closer !== null) {
      const end = line.indexOf(closer);
      if (end >= 0) {
        line = line.slice(0, end);
        closer = null;
      }
      text = line.replace(/^\*+\s?/u, "").trim();
    } else {
      const block = /^("""|'''|\/\*+|<#)(.*)$/u.exec(line);
      if (block) {
        const close = block[1] === "<#" ? "#>" : block[1]!.startsWith("/*") ? "*/" : block[1]!;
        const rest = block[2]!;
        const end = rest.indexOf(close);
        if (end >= 0) text = rest.slice(0, end).trim();
        else {
          text = rest.trim();
          closer = close;
        }
      } else {
        const comment = /^(?:#+|\/\/+|--+|%+|;+)(.*)$/u.exec(line);
        if (comment) text = comment[1]!.trim();
        else codeUsage ??= printedUsage(line);
      }
    }
    if (!text || PRAGMA.test(text)) continue;
    if (/\busage\b/iu.test(text)) return boundUsage(text);
    firstComment ??= text;
  }
  const usage = codeUsage ?? firstComment;
  return usage === undefined ? undefined : boundUsage(usage);
}

/** Code such as echo "Usage: $0 --from DATE" still names the command. */
function printedUsage(line: string): string | undefined {
  const at = line.search(/\busage\s*:/iu);
  if (at < 0) return undefined;
  let usage = line.slice(at);
  // Inside a string literal, stop at its closing quote.
  const quote = /(["'`])[^"'`]*$/u.exec(line.slice(0, at))?.[1];
  if (quote) {
    const end = usage.indexOf(quote);
    if (end >= 0) usage = usage.slice(0, end);
  }
  return usage.replace(/[\s;,)]+$/u, "") || undefined;
}

function boundUsage(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ");
  return collapsed.length > SKILL_SCRIPT_USAGE_MAX_CHARS
    ? `${collapsed.slice(0, SKILL_SCRIPT_USAGE_MAX_CHARS - 3)}...`
    : collapsed;
}

/** Partial text edits preserve omitted files; deletion is always explicit. */
export function applySkillFileChanges(
  current: readonly SkillTextFile[],
  changes: readonly SkillTextFile[],
  deletions: readonly string[] = [],
): SkillTextFile[] {
  const next = new Map<string, SkillTextFile>();
  for (const file of current) {
    assertSkillRelativePath(file.path);
    if (next.has(file.path)) {
      throw new SkillFileError("invalid_request", `Duplicate stored Skill path: ${file.path}`);
    }
    next.set(file.path, { ...file });
  }
  const touched = new Set<string>();
  for (const path of deletions) {
    assertSkillRelativePath(path);
    if (touched.has(path)) {
      throw new SkillFileError("invalid_request", `Duplicate deleted Skill path: ${path}`);
    }
    touched.add(path);
    if (!next.delete(path)) {
      throw new SkillFileError("missing_file", `Cannot delete missing Skill file: ${path}`);
    }
  }
  for (const file of changes) {
    assertSkillRelativePath(file.path);
    if (touched.has(file.path)) {
      throw new SkillFileError("invalid_request", `Conflicting Skill edit: ${file.path}`);
    }
    touched.add(file.path);
    next.set(file.path, { ...file });
  }
  if (!next.has("SKILL.md")) {
    throw new SkillFileError("missing_file", "A Skill must contain SKILL.md.");
  }
  return [...next.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
