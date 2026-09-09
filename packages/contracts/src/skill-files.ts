/** Shared text-folder limits for API admission, runtime imports and checkout. */
export const SKILL_MAX_FILES = 128;
export const SKILL_MAX_FILE_BYTES = 256 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 1024 * 1024;

export function isSafeSkillRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(path),
    ) === path
  );
}

/** Validates bytes, not extensions. Does not rewrite text or interpret metadata. */
export function validateSkillTextFiles(files: readonly { path: string; content: string }[]): {
  totalBytes: number;
} {
  if (files.length === 0 || files.length > SKILL_MAX_FILES)
    throw new Error(`Skill artifact must contain 1-${SKILL_MAX_FILES} files`);
  const paths = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let totalBytes = 0;
  for (const { path, content } of files) {
    if (!isSafeSkillRelativePath(path))
      throw new Error(`Skill artifact contains an unsafe path: ${path}`);
    if (paths.has(path)) throw new Error(`Skill artifact contains duplicate file path: ${path}`);
    paths.add(path);
    if (content.includes("\u0000")) throw new Error(`Skill artifact contains NUL bytes: ${path}`);
    const bytes = encoder.encode(content);
    if (decoder.decode(bytes) !== content)
      throw new Error(`Skill artifact contains malformed Unicode text: ${path}`);
    if (bytes.byteLength > SKILL_MAX_FILE_BYTES)
      throw new Error(`Skill artifact file exceeds ${SKILL_MAX_FILE_BYTES} bytes: ${path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > SKILL_MAX_TOTAL_BYTES)
      throw new Error(`Skill artifact exceeds ${SKILL_MAX_TOTAL_BYTES} bytes`);
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const prefix = segments.slice(0, index).join("/");
      if (paths.has(prefix))
        throw new Error(`Skill artifact uses a path as both a file and a directory: ${prefix}`);
    }
  }
  return { totalBytes };
}
