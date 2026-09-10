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
