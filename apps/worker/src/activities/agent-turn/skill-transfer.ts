import { posix } from "node:path";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import {
  assertSkillRelativePath,
  buildPortableSkillArtifact,
  PORTABLE_SKILL_MAX_FILES,
  PORTABLE_SKILL_MAX_FILE_BYTES,
  PORTABLE_SKILL_MAX_TOTAL_BYTES,
  SKILL_READ_MAX_PATHS,
  SkillFileError,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export type SkillFileSystem = Pick<SandboxChannelAService, "fsList" | "fsRead" | "fsWriteFiles">;
const maxTraversalEntries = 1024;

/** Reuse the host's cancellation and workspace-mutation authority for each filesystem operation. */
export function guardSkillFilesystem(
  fs: SkillFileSystem,
  authority: {
    assertActive: () => void;
    runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  },
): SkillFileSystem {
  const read = <T>(operation: () => Promise<T>): Promise<T> => {
    authority.assertActive();
    return operation();
  };
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    authority.assertActive();
    return authority.runMutation(() => read(operation));
  };
  return {
    fsList: (request) => read(() => fs.fsList(request)),
    fsRead: (request) => read(() => fs.fsRead(request)),
    fsWriteFiles: (request) => write(() => fs.fsWriteFiles(request)),
  };
}

export type SkillCheckoutResult = {
  directory: string;
  fileCount: number;
  written: number;
  unchanged: number;
  /** This call created the directory, so it holds nothing but these files. */
  createdDirectory: boolean;
};

/**
 * Caller supplies an authorized live filesystem and a workspace-relative
 * target. All missing files are created in one filesystem batch (normally a
 * single sandbox command). Nothing is overwritten: files already holding the
 * same bytes are kept, and any other existing entry fails before writing.
 * `paths` selects exactly those Skill files, for example one script to run.
 */
export async function checkoutSkillDirectory(
  fs: Pick<SkillFileSystem, "fsWriteFiles">,
  directory: string,
  files: readonly SkillTextFile[],
  options: { paths?: readonly string[] } = {},
): Promise<SkillCheckoutResult> {
  assertSkillRelativePath(directory);
  const artifact = buildPortableSkillArtifact(files);
  const selected =
    options.paths === undefined
      ? artifact.files
      : selectSkillCheckoutFiles(artifact.files, options.paths);
  const result = await fs.fsWriteFiles({
    directory,
    files: selected.map((file) => ({ path: file.path, content: file.content, encoding: "utf8" })),
  });
  if (result.written.length + result.unchanged.length !== selected.length) {
    throw new Error("Skill checkout returned an incomplete result.");
  }
  return {
    directory,
    fileCount: selected.length,
    written: result.written.length,
    unchanged: result.unchanged.length,
    createdDirectory: result.createdDirectory,
  };
}

function selectSkillCheckoutFiles(
  files: readonly SkillTextFile[],
  paths: readonly string[],
): SkillTextFile[] {
  if (paths.length === 0 || paths.length > SKILL_READ_MAX_PATHS) {
    throw new SkillFileError(
      "invalid_request",
      `Request between 1 and ${SKILL_READ_MAX_PATHS} paths, or omit paths for the whole Skill.`,
    );
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  return paths.map((path) => {
    assertSkillRelativePath(path);
    if (seen.has(path)) {
      throw new SkillFileError("invalid_request", `Duplicate requested Skill path: ${path}`);
    }
    seen.add(path);
    const file = byPath.get(path);
    if (!file) throw new SkillFileError("missing_file", `Skill file not found: ${path}`);
    return file;
  });
}

/**
 * Read a folder through existing structured filesystem services, never via model
 * arguments. The caller owns workspace confinement and the final governed save.
 * This operation does not execute scripts or activate the resulting artifact.
 */
export async function readSkillDirectory(
  fs: Pick<SkillFileSystem, "fsList" | "fsRead">,
  directory: string,
) {
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
