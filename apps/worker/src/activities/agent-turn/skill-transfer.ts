import { posix } from "node:path";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import {
  assertSkillRelativePath,
  buildPortableSkillArtifact,
  PORTABLE_SKILL_MAX_FILES,
  PORTABLE_SKILL_MAX_FILE_BYTES,
  PORTABLE_SKILL_MAX_TOTAL_BYTES,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

type SkillFileSystem = Pick<SandboxChannelAService, "fsList" | "fsRead" | "fsWrite" | "fsMkdir">;
const maxTraversalEntries = 1024;

/** Caller supplies an authorized live filesystem and a fresh workspace-relative target. */
export async function checkoutSkillDirectory(
  fs: SkillFileSystem,
  directory: string,
  files: readonly SkillTextFile[],
): Promise<{ directory: string; fileCount: number }> {
  assertSkillRelativePath(directory);
  const artifact = buildPortableSkillArtifact(files);
  const parent = posix.dirname(directory);
  if (parent !== ".") await fs.fsMkdir({ path: parent, recursive: true });
  // Never overwrite an earlier checkout (which may now contain the user's edits).
  await fs.fsMkdir({ path: directory, recursive: false });
  for (const file of artifact.files) {
    const result = await fs.fsWrite({
      path: `${directory}/${file.path}`,
      content: file.content,
      encoding: "utf8",
      overwrite: false,
      createParents: true,
    });
    if (result.sizeBytes !== new TextEncoder().encode(file.content).byteLength) {
      throw new Error(`Skill checkout wrote an unexpected byte count: ${file.path}`);
    }
  }
  return { directory, fileCount: artifact.files.length };
}

/**
 * Read a folder through existing structured filesystem services, never via model
 * arguments. The caller owns workspace confinement and the final governed save.
 * This operation does not execute scripts or activate the resulting artifact.
 */
export async function readSkillDirectory(fs: SkillFileSystem, directory: string) {
  assertSkillRelativePath(directory);
  const pending = [directory];
  const seen = new Set<string>(pending);
  const files: SkillTextFile[] = [];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.shift()!;
    const listing = await fs.fsList({
      path: current,
      depth: 1,
      maxEntries: maxTraversalEntries + 1,
      includeHidden: true,
    });
    if (listing.root.type !== "dir" || listing.root.path !== current) {
      throw new Error(`Expected a real Skill directory: ${current}`);
    }
    if (listing.truncated || listing.root.truncated || !listing.root.children) {
      throw new Error(`Skill directory listing is incomplete: ${current}`);
    }
    for (const entry of listing.root.children) {
      assertSkillRelativePath(entry.path);
      if (posix.dirname(entry.path) !== current || posix.basename(entry.path) !== entry.name) {
        throw new Error("Skill directory listing returned a path outside the requested directory.");
      }
      if (seen.has(entry.path)) throw new Error(`Duplicate Skill directory entry: ${entry.path}`);
      seen.add(entry.path);
      if (++entries > maxTraversalEntries) throw new Error("Skill directory has too many entries.");
      if (entry.type === "dir") {
        pending.push(entry.path);
        continue;
      }
      if (entry.type !== "file") throw new Error(`Unsupported Skill file type: ${entry.path}`);
      if (files.length >= PORTABLE_SKILL_MAX_FILES) throw new Error("Skill has too many files.");
      if (entry.sizeBytes !== null && entry.sizeBytes > PORTABLE_SKILL_MAX_FILE_BYTES) {
        throw new Error(`Skill file exceeds the size limit: ${entry.path}`);
      }
      const read = await fs.fsRead({
        path: entry.path,
        encoding: "base64",
        maxBytes: PORTABLE_SKILL_MAX_FILE_BYTES + 1,
      });
      if (read.truncated || read.sizeBytes > PORTABLE_SKILL_MAX_FILE_BYTES) {
        throw new Error(`Skill file exceeds the size limit: ${entry.path}`);
      }
      if (read.encoding !== "base64" || read.path !== entry.path) {
        throw new Error(`Invalid Skill file read response: ${entry.path}`);
      }
      const bytes = Buffer.from(read.content, "base64");
      if (bytes.byteLength !== read.sizeBytes) {
        throw new Error(`Invalid Skill file byte count: ${entry.path}`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > PORTABLE_SKILL_MAX_TOTAL_BYTES)
        throw new Error("Skill exceeds the total size limit.");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error(`Skill file is not valid UTF-8 text: ${entry.path}`);
      }
      files.push({ path: entry.path.slice(directory.length + 1), content });
    }
  }
  return buildPortableSkillArtifact(files);
}
