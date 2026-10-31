// The batcher's side of regenerating generated files on a conflict: what a
// regeneration run reports (scripts/ci/regenerate-merge.ts) and how the
// batcher checks it before writing anything to a PR's branch.
import { inflateRawSync } from "node:zlib";
import { REGENERATED_ON_CONFLICT, regenerates } from "../ci/check-generated-artifacts";

export const REGENERATE_WORKFLOW = ".github/workflows/regenerate-generated.yml";
/** The artifact a regeneration run uploads, and the one file in it. */
export const REGENERATION_ARTIFACT = "regeneration";
export const REGENERATION_FILE = "regeneration.json";

/** The workflow's run name for one PR head, which is how the batcher finds its runs. */
export const regenerationTitle = (pull: number, head: string) => `Regenerate #${pull} at ${head}`;

export type RegeneratedFile =
  | { path: string; mode: string; content: string }
  | { path: string; deleted: true };

export type Regeneration = { version: 1; pull: number; head: string; main: string } & (
  | { outcome: "clean" }
  | { outcome: "conflict"; conflicted: string[] }
  | {
      outcome: "regenerated";
      conflicted: string[];
      /** The merge of main once each conflicted file takes main's version. */
      mergedTree: string;
      commands: string[];
      /** Every file regenerating changed in `mergedTree`, with its new content in base64. */
      files: RegeneratedFile[];
    }
);

/** A file the batcher may regenerate: a registered generated artifact. */
export function generated(path: string): boolean {
  return REGENERATED_ON_CONFLICT.some((entry) => regenerates(entry, path));
}

const SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/[\0\\]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * The run's result for exactly this PR head, or null when the text is not
 * one. The run executed the PR's code, so nothing in it is trusted beyond what
 * the PR's own branch may hold: every path it names must be a registered
 * generated file, and the batcher repeats the merge itself and compares trees.
 */
export function parseRegeneration(text: string, pull: number, head: string): Regeneration | null {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.version !== 1 || value.pull !== pull || value.head !== head) return null;
  if (typeof value.main !== "string" || !SHA.test(value.main)) return null;
  const base = { version: 1 as const, pull, head, main: value.main };
  if (value.outcome === "clean") return { ...base, outcome: "clean" };
  const conflicted = value.conflicted;
  if (!Array.isArray(conflicted) || !conflicted.length || !conflicted.every(repositoryPath))
    return null;
  if (value.outcome === "conflict") return { ...base, outcome: "conflict", conflicted };
  if (value.outcome !== "regenerated" || !conflicted.every(generated)) return null;
  const { mergedTree, commands, files } = value;
  if (typeof mergedTree !== "string" || !SHA.test(mergedTree)) return null;
  if (!Array.isArray(commands) || !commands.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(files)) return null;
  const seen = new Set<string>();
  const checked: RegeneratedFile[] = [];
  for (const file of files as unknown[]) {
    if (typeof file !== "object" || file === null) return null;
    const { path, mode, content, deleted } = file as Record<string, unknown>;
    if (!repositoryPath(path) || !generated(path) || seen.has(path)) return null;
    seen.add(path);
    if (deleted === true) checked.push({ path, deleted: true });
    else if (
      (mode === "100644" || mode === "100755") &&
      typeof content === "string" &&
      BASE64.test(content)
    )
      checked.push({ path, mode, content });
    else return null;
  }
  return {
    ...base,
    outcome: "regenerated",
    conflicted,
    mergedTree,
    commands: commands as string[],
    files: checked,
  };
}

/**
 * One file's text from a zip archive, as GitHub serves an artifact, or null
 * when the archive does not hold it. Stored and deflated entries only.
 */
export function unzipText(archive: Uint8Array, name: string): string | null {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end of central directory record is last, after a comment of up to 64 KiB.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (at + 46 > archive.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (entry !== name) continue;
    if (local + 30 > archive.length || view.getUint32(local, true) !== 0x04034b50) return null;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = archive.subarray(start, start + size);
    if (data.length !== size) return null;
    if (method === 0) return decoder.decode(data);
    if (method === 8) return decoder.decode(inflateRawSync(data));
    return null;
  }
  return null;
}
