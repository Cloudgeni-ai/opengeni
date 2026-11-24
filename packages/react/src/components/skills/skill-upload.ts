/**
 * Turns what a person uploads into one Skill folder: a single SKILL.md, a
 * folder (picked or dropped) or a .zip. The folder's top is where its
 * SKILL.md sits, so an archive or folder that wraps the Skill in a directory
 * ("my-skill/SKILL.md") uploads the same as the bare folder. Text files only:
 * anything that isn't UTF-8 text is left out and named, never sent.
 *
 * Nothing here talks to the server; the result opens as an unsaved draft the
 * person reviews and saves.
 */
import {
  isSafeSkillRelativePath,
  parseSkillFrontmatter,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  SkillFrontmatterError,
  validateSkillTextFiles,
  type SkillFile,
} from "@opengeni/contracts";

/** One uploaded file: its path as uploaded (folder names included) and its bytes. */
export type SkillUploadEntry = { path: string; bytes: Uint8Array };

export type SkillUpload = {
  /** The Skill folder, SKILL.md first. */
  files: SkillFile[];
  /** The `name` in SKILL.md's frontmatter, when it has one. */
  name: string | null;
  /** Files left out, with why: "logo.png (not a text file)". */
  skipped: string[];
};

/** A plain sentence saying what is wrong with the upload and how to fix it. */
export class SkillUploadError extends Error {
  override readonly name = "SkillUploadError";
}

const MiB = 1024 * 1024;
/** An archive larger than this can't be a Skill (the folder limit is 8 MB of text). */
const MAX_ARCHIVE_BYTES = 32 * MiB;
const MAX_ARCHIVE_ENTRIES = 4 * SKILL_MAX_FILES;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / MiB)} MB`;
}

/** Operating-system and version-control leftovers that are never part of a Skill. */
function isJunk(path: string): boolean {
  return path
    .split("/")
    .some(
      (segment) =>
        segment === "__MACOSX" ||
        segment === ".git" ||
        segment === ".DS_Store" ||
        segment === "Thumbs.db" ||
        segment === "desktop.ini" ||
        segment.startsWith("._"),
    );
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isSkillMarkdown(path: string): boolean {
  return basename(path).toLowerCase() === "skill.md";
}

function isZip(path: string, bytes: Uint8Array): boolean {
  return (
    path.toLowerCase().endsWith(".zip") ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
  );
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Uint8Array): string | null {
  try {
    const content = utf8.decode(bytes);
    return content.includes("\u0000") ? null : content;
  } catch {
    return null;
  }
}

/**
 * Folds uploaded files into one Skill folder. Expands a lone .zip first.
 * Throws SkillUploadError when there is no SKILL.md, more than one Skill, or
 * the folder breaks the Skill limits.
 */
export async function readSkillUploadEntries(
  uploaded: readonly SkillUploadEntry[],
): Promise<SkillUpload> {
  let entries = uploaded
    .map((entry) => ({ path: normalizePath(entry.path), bytes: entry.bytes }))
    .filter((entry) => entry.path && !isJunk(entry.path));
  const archives = entries.filter((entry) => isZip(entry.path, entry.bytes));
  if (archives.length) {
    if (entries.length > 1)
      throw new SkillUploadError("Upload one .zip file on its own, or a folder without archives.");
    entries = (await unzipSkillArchive(archives[0]!.bytes))
      .map((entry) => ({ path: normalizePath(entry.path), bytes: entry.bytes }))
      .filter((entry) => entry.path && !isJunk(entry.path));
  }
  if (!entries.length) throw new SkillUploadError("There are no files in this upload.");

  let candidates = entries.filter((entry) => isSkillMarkdown(entry.path));
  // A lone Markdown file is the SKILL.md, whatever it is called.
  if (!candidates.length && entries.length === 1 && /\.(md|markdown)$/iu.test(entries[0]!.path))
    candidates = entries;
  if (!candidates.length)
    throw new SkillUploadError(
      "There's no SKILL.md in this upload. A skill is a folder with a SKILL.md file at its top.",
    );
  const depth = (path: string) => path.split("/").length;
  const shallowest = Math.min(...candidates.map((entry) => depth(entry.path)));
  const tops = candidates.filter((entry) => depth(entry.path) === shallowest);
  if (tops.length > 1) {
    const folders = tops.map((entry) => entry.path.split("/").at(-2) ?? entry.path).slice(0, 3);
    throw new SkillUploadError(
      `This upload holds ${tops.length} skills (${folders.join(", ")}${tops.length > 3 ? ", …" : ""}). Upload one skill at a time.`,
    );
  }
  const top = tops[0]!;
  const root = top.path.includes("/") ? top.path.slice(0, top.path.lastIndexOf("/") + 1) : "";

  const files: SkillFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(root)) {
      skipped.push(`${entry.path} (outside the skill folder)`);
      continue;
    }
    const path = entry === top ? "SKILL.md" : entry.path.slice(root.length);
    if (path !== "SKILL.md" && path.toLowerCase() === "skill.md") continue;
    const content = text(entry.bytes);
    if (content === null) {
      if (entry === top) throw new SkillUploadError("SKILL.md isn't a UTF-8 text file.");
      skipped.push(`${path} (not a text file)`);
      continue;
    }
    if (!isSafeSkillRelativePath(path))
      throw new SkillUploadError(
        `"${path}" isn't a file name a skill can use. Rename it and try again.`,
      );
    if (entry.bytes.byteLength > SKILL_MAX_FILE_BYTES)
      throw new SkillUploadError(
        `${path} is larger than ${megabytes(SKILL_MAX_FILE_BYTES)}, the most one skill file can be.`,
      );
    totalBytes += entry.bytes.byteLength;
    files.push({ path, content });
  }
  if (files.length > SKILL_MAX_FILES)
    throw new SkillUploadError(
      `A skill can have at most ${SKILL_MAX_FILES} files; this one has ${files.length}.`,
    );
  if (totalBytes > SKILL_MAX_TOTAL_BYTES)
    throw new SkillUploadError(
      `This skill's text files add up to more than ${megabytes(SKILL_MAX_TOTAL_BYTES)}, the most a skill can hold.`,
    );
  files.sort((left, right) =>
    left.path === "SKILL.md"
      ? -1
      : right.path === "SKILL.md"
        ? 1
        : left.path.localeCompare(right.path),
  );
  let name: string | null = null;
  try {
    name = parseSkillFrontmatter(files[0]!.content).name;
  } catch {
    // Saving names the header problem; the draft still opens so it can be fixed.
  }
  return { files, name, skipped };
}

/** A file from an input or a drop, with the folder path it was picked or dropped with. */
export type UploadedFile = File & { relativePath?: string };

/** Reads picked or dropped files (with their folder paths) into one Skill folder. */
export async function readSkillUpload(files: Iterable<UploadedFile>): Promise<SkillUpload> {
  const list = [...files];
  const size = list.reduce((sum, file) => sum + file.size, 0);
  if (size > MAX_ARCHIVE_BYTES)
    throw new SkillUploadError(
      `This upload is ${megabytes(size)}. A skill holds at most ${megabytes(SKILL_MAX_TOTAL_BYTES)} of text.`,
    );
  return readSkillUploadEntries(
    await Promise.all(
      list.map(async (file) => ({
        path: file.relativePath || file.webkitRelativePath || file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    ),
  );
}

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (resolve: (file: File) => void, reject: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: FileSystemEntryLike[]) => void,
      reject: (error: unknown) => void,
    ) => void;
  };
};

async function walk(entry: FileSystemEntryLike, into: UploadedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    into.push(Object.assign(file, { relativePath: entry.fullPath.replace(/^\/+/u, "") }));
    if (into.length > MAX_ARCHIVE_ENTRIES)
      throw new SkillUploadError("This folder has too many files to be a skill.");
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  if (isJunk(entry.fullPath.replace(/^\/+/u, ""))) return;
  const reader = entry.createReader();
  // readEntries returns a directory in batches until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return;
    for (const child of batch) await walk(child, into);
  }
}

/** The files of a drop, with folders read recursively. */
export async function filesFromDrop(transfer: DataTransfer): Promise<UploadedFile[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => (item.webkitGetAsEntry?.() ?? null) as FileSystemEntryLike | null);
  if (!entries.length || entries.some((entry) => !entry)) return [...transfer.files];
  const files: UploadedFile[] = [];
  for (const entry of entries) await walk(entry!, files);
  return files;
}

/* ---------------------------------------------------------------------------
   A small, bounded ZIP reader: stored and deflated entries, read through the
   platform's DecompressionStream. No ZIP64, encryption or multi-disk archives.
   ------------------------------------------------------------------------- */

function zipFailure(message: string): never {
  throw new SkillUploadError(message);
}

/**
 * What would stop a Skill folder from saving, in words for the person editing
 * it, or null when it can be saved. Mirrors the server's checks so the editor
 * can say what to fix before a round trip.
 */
export function skillFilesProblem(files: readonly SkillFile[]): string | null {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) return "A skill needs a SKILL.md file.";
  let header: { name: string | null; description: string | null };
  try {
    header = parseSkillFrontmatter(skill.content);
  } catch (error) {
    return error instanceof SkillFrontmatterError
      ? "The header at the top of SKILL.md isn't valid YAML. Check its quotes, colons and indentation."
      : "The header at the top of SKILL.md can't be read.";
  }
  if (!header.name && !header.description)
    return "Start SKILL.md with a header between two --- lines that gives the skill a name and a description.";
  if (!header.name)
    return "Add a name to the header at the top of SKILL.md, like name: release-notes.";
  if (header.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(header.name))
    return `The name "${header.name.slice(0, 64)}" can only use lowercase letters, numbers and single hyphens, like release-notes.`;
  if (!header.description?.trim())
    return "Add a description to the header at the top of SKILL.md: when agents should use this skill.";
  if (header.description.length > 1024)
    return `The description in SKILL.md is ${header.description.length.toLocaleString("en")} characters; it can be at most 1,024.`;
  for (const file of files)
    if (!isSafeSkillRelativePath(file.path))
      return `"${file.path}" isn't a file name a skill can use. Use a relative path like references/notes.md.`;
  try {
    validateSkillTextFiles(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/duplicate/iu.test(message)) return "Two files have the same name. Rename one of them.";
    if (/both a file and a directory/iu.test(message))
      return "A file and a folder have the same name. Rename one of them.";
    if (/exceeds/iu.test(message))
      return `This skill is too large. Each file can be at most ${megabytes(SKILL_MAX_FILE_BYTES)} and the whole skill ${megabytes(SKILL_MAX_TOTAL_BYTES)}.`;
    return "A file in this skill isn't plain text.";
  }
  return null;
}

async function inflateRaw(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined")
    zipFailure("This browser can't open .zip files. Upload the skill's folder instead.");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected) zipFailure("This .zip file is damaged.");
      out.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    if (error instanceof SkillUploadError) throw error;
    zipFailure("This .zip file is damaged.");
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (offset !== expected) zipFailure("This .zip file is damaged.");
  return out;
}

/** The files in a ZIP archive, in archive order. Directories are left out. */
export async function unzipSkillArchive(bytes: Uint8Array): Promise<SkillUploadEntry[]> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    zipFailure(`This .zip file is larger than ${megabytes(MAX_ARCHIVE_BYTES)}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) zipFailure("This file isn't a .zip archive, or it is damaged.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff)
    zipFailure("This .zip uses a format the upload can't read (ZIP64). Upload the folder instead.");
  if (count > MAX_ARCHIVE_ENTRIES) zipFailure("This .zip has too many files to be a skill.");
  if (directoryOffset + directorySize > end) zipFailure("This .zip file is damaged.");

  const names = new TextDecoder("utf-8");
  const entries: SkillUploadEntry[] = [];
  let expanded = 0;
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      zipFailure("This .zip file is damaged.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 0x1) zipFailure("This .zip is password-protected. Upload it without a password.");
    if (method !== 0 && method !== 8)
      zipFailure(
        "This .zip uses a compression method the upload can't read. Re-create it with standard compression.",
      );
    expanded += size;
    if (size > SKILL_MAX_FILE_BYTES * 4 || expanded > MAX_ARCHIVE_BYTES)
      zipFailure(
        `This .zip expands to more than ${megabytes(MAX_ARCHIVE_BYTES)}, too much for a skill.`,
      );
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50)
      zipFailure("This .zip file is damaged.");
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > bytes.byteLength) zipFailure("This .zip file is damaged.");
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (isJunk(normalizePath(name))) continue;
    entries.push({
      path: name,
      bytes: method === 0 ? data.slice() : await inflateRaw(data, size),
    });
  }
  return entries;
}
