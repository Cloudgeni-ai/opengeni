/**
 * Robust function `apply_patch` (OPENGENI_EXPERIMENT_APPLY_PATCH_ROBUST).
 *
 * Two general failure modes cost the model extra steps:
 *
 * - An `*** Add File: <path>` section with no `+` lines. Codex's apply_patch
 *   creates an empty file; the Agents SDK parser rejects the whole patch,
 *   including its other files. Here it becomes a `create_file` with an empty
 *   diff, so the editor creates an empty file and the other sections apply.
 * - "Invalid Context": a hunk's context lines do not match the file. The SDK
 *   only reports the context it looked for, so the model usually reads the file
 *   before retrying. Here the error is followed by the closest matching region
 *   of the current file (bounded, with line numbers and the path). When the
 *   section's hunks each match exactly one place in the file but were written
 *   out of file order (the SDK only searches forward from the previous hunk),
 *   the section is applied once more with its hunks in file order.
 *
 * The patch is applied one file section at a time through the inner tool as
 * structured operations, which is how the SDK applies a parsed patch anyway:
 * every section reports its own result, and a failed section does not undo or
 * stop the others. When there is more than one section or one failed, each
 * result names its operation and path ("Updated a.py: Patch applied.",
 * "Update b.py failed: ..."), and a partly applied patch says that only the
 * failed sections need resending. A single applied section keeps the plain
 * "Patch applied.". Input this parser cannot read is passed through
 * unchanged, so it keeps the SDK's own handling and error.
 */
import type { Tool } from "@openai/agents";
import { isRecord } from "@opengeni/contracts/values";
import { withLenientPatchFraming } from "./apply-patch-add-file";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export type RobustPatchOperation =
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; diff: string; moveTo?: string }
  | { type: "delete_file"; path: string };

function isFileOperationHeader(line: string): boolean {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function headerPath(line: string, prefix: string): string | null {
  const path = line.slice(prefix.length).trim();
  return path || null;
}

function joinDiff(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a freeform patch into file operations exactly as the SDK parser does
 * (after the same lenient framing repairs the model-facing tool applies),
 * except that an Add File section with no lines is an empty file. Returns null
 * for anything the SDK would reject for another reason.
 */
export function parseRobustPatch(patch: string): RobustPatchOperation[] | null {
  const raw = patch.trimStart().split(/\r?\n/);
  if (raw[0] !== BEGIN_PATCH) return null;
  const lines = withLenientPatchFraming(raw);
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== BEGIN_PATCH || lines.length < 2 || lines.at(-1) !== END_PATCH) return null;
  const operations: RobustPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    const body: string[] = [];
    let moveTo: string | undefined;
    let next = index + 1;
    if (
      line.startsWith(UPDATE_FILE) &&
      lines[next]?.startsWith(MOVE_TO) &&
      next < lines.length - 1
    ) {
      const target = headerPath(lines[next]!, MOVE_TO);
      if (!target) return null;
      moveTo = target;
      next += 1;
    }
    while (next < lines.length - 1 && !isFileOperationHeader(lines[next]!)) {
      body.push(lines[next]!);
      next += 1;
    }
    if (line.startsWith(ADD_FILE)) {
      const path = headerPath(line, ADD_FILE);
      if (!path || body.some((entry) => !entry.startsWith("+"))) return null;
      operations.push({ type: "create_file", path, diff: body.length ? joinDiff(body) : "" });
    } else if (line.startsWith(DELETE_FILE)) {
      const path = headerPath(line, DELETE_FILE);
      if (!path || body.length) return null;
      operations.push({ type: "delete_file", path });
    } else if (line.startsWith(UPDATE_FILE)) {
      const path = headerPath(line, UPDATE_FILE);
      if (!path || (!body.length && !moveTo)) return null;
      operations.push({
        type: "update_file",
        path,
        diff: body.length ? joinDiff(body) : "",
        ...(moveTo ? { moveTo } : {}),
      });
    } else {
      return null;
    }
    index = next;
  }
  return operations.length ? operations : null;
}

/** The patch string of a model-facing `apply_patch` input, or null. */
function patchOf(input: string): string | null {
  if (input.trimStart().startsWith(BEGIN_PATCH)) return input;
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof payload === "string") return payload;
  return isRecord(payload) && typeof payload.patch === "string" ? payload.patch : null;
}

const MAX_REGION_LINES = 40;
const REGION_MARGIN = 5;
const MAX_LINE_CHARS = 240;
const MIN_MATCH_SCORE = 0.5;

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Dice similarity of two lines, ignoring surrounding whitespace (0..1). */
function lineSimilarity(left: string, right: string): number {
  const a = left.trim();
  const b = right.trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const gramsA = bigrams(a);
  let shared = 0;
  for (const [gram, count] of bigrams(b)) shared += Math.min(count, gramsA.get(gram) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * The region of `content` that best matches `context` (the lines a failed hunk
 * looked for), with a few lines around it, numbered from 1, or a one-line note
 * when nothing is reasonably close. Bounded to about 40 lines.
 */
export function closestContextRegion(
  content: string,
  context: readonly string[],
  path: string,
): string {
  const fileLines = content.split("\n");
  if (fileLines.at(-1) === "") fileLines.pop();
  const probe = context.length > MAX_REGION_LINES ? context.slice(0, MAX_REGION_LINES) : context;
  const scored = probe.filter((line) => line.trim() !== "");
  if (!fileLines.length || !scored.length) {
    return `No close match for these context lines in ${path}.`;
  }
  // Exact (trimmed) comparison only on very large inputs keeps this cheap.
  const fuzzy = fileLines.length * probe.length <= 400_000;
  let best = -1;
  let bestScore = 0;
  for (let start = 0; start < fileLines.length; start += 1) {
    let score = 0;
    for (let offset = 0; offset < probe.length; offset += 1) {
      const expected = probe[offset]!;
      if (expected.trim() === "") continue;
      const actual = fileLines[start + offset];
      if (actual === undefined) break;
      score += fuzzy ? lineSimilarity(expected, actual) : expected.trim() === actual.trim() ? 1 : 0;
    }
    score /= scored.length;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  if (best < 0 || bestScore < MIN_MATCH_SCORE) {
    return `No close match for these context lines in ${path}.`;
  }
  let from = Math.max(0, best - REGION_MARGIN);
  let to = Math.min(fileLines.length, best + probe.length + REGION_MARGIN);
  if (to - from > MAX_REGION_LINES) {
    from = Math.max(0, best - 2);
    to = Math.min(fileLines.length, from + MAX_REGION_LINES);
  }
  const width = String(to).length;
  const body = fileLines.slice(from, to).map((line, offset) => {
    const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
    return `${String(from + offset + 1).padStart(width)}| ${text}`;
  });
  return [`Closest match in ${path} (lines ${from + 1}-${to}):`, ...body].join("\n");
}

type Hunk = { lines: string[]; old: string[] };

function splitHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  for (const line of lines) {
    if (line.startsWith("@@") || !hunks.length) hunks.push({ lines: [], old: [] });
    const hunk = hunks.at(-1)!;
    hunk.lines.push(line);
    if (line.startsWith("@@") || line === END_OF_FILE) continue;
    if (line === "" || line.startsWith(" ") || line.startsWith("-")) hunk.old.push(line.slice(1));
  }
  return hunks;
}

function occurrences(
  fileLines: readonly string[],
  block: readonly string[],
  normalize: (line: string) => string,
): number[] {
  const found: number[] = [];
  const target = block.map(normalize);
  for (let start = 0; start + target.length <= fileLines.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < target.length && match; offset += 1) {
      match = normalize(fileLines[start + offset]!) === target[offset];
    }
    if (match) found.push(start);
  }
  return found;
}

/**
 * The update diff with its hunks in file order, when every hunk's old lines
 * match exactly one place in `content`, those places do not overlap, and the
 * diff had them in another order. Otherwise null.
 */
export function reorderHunksByFile(content: string, diff: string): string | null {
  const hunks = splitHunks(diff);
  if (hunks.length < 2) return null;
  const fileLines = content.split("\n");
  const placed: { hunk: Hunk; at: number; order: number }[] = [];
  for (const [order, hunk] of hunks.entries()) {
    if (!hunk.old.length || hunk.lines.includes(END_OF_FILE)) return null;
    let at: number[] = [];
    for (const normalize of [
      (line: string) => line,
      (line: string) => line.trimEnd(),
      (line: string) => line.trim(),
    ]) {
      at = occurrences(fileLines, hunk.old, normalize);
      if (at.length) break;
    }
    if (at.length !== 1) return null;
    placed.push({ hunk, at: at[0]!, order });
  }
  placed.sort((left, right) => left.at - right.at);
  if (placed.every((entry, index) => entry.order === index)) return null;
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1]!;
    if (previous.at + previous.hunk.old.length > placed[index]!.at) return null;
  }
  const lines = placed.flatMap(({ hunk }) =>
    hunk.lines[0]!.startsWith("@@") ? hunk.lines : ["@@", ...hunk.lines],
  );
  return joinDiff(lines);
}

const CONTEXT_FAILURE = /^Failed to apply patch: Invalid (?:EOF )?Context \d+:\n?/;

function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

export type ApplyPatchFileReader = (path: string) => Promise<string | null>;

const APPLIED = "Patch applied.";
const FAILURE_PREFIX = /^(?:Failed to apply patch|Patch failed): ?/;
export const PARTIAL_APPLY_NOTE =
  "Sections that applied are saved; resend only the failed sections.";

function sectionTarget(operation: RobustPatchOperation): string {
  return operation.type === "update_file" && operation.moveTo
    ? `${operation.path} (moved to ${operation.moveTo})`
    : operation.path;
}

/** One section's result named by its operation and path. */
export function labelSectionResult(operation: RobustPatchOperation, output: string): string {
  const [done, verb] =
    operation.type === "create_file"
      ? ["Added", "Add"]
      : operation.type === "delete_file"
        ? ["Deleted", "Delete"]
        : ["Updated", "Update"];
  const target = sectionTarget(operation);
  if (output === APPLIED) return `${done} ${target}: ${APPLIED}`;
  return `${verb} ${target} failed: ${output.replace(FAILURE_PREFIX, "") || "Patch failed."}`;
}

/**
 * Apply the function `apply_patch` one file section at a time (see the module
 * comment). `readFile` reads the current text of a workspace file, or null.
 */
export function withApplyPatchRobust(
  tools: Tool<unknown>[],
  readFile: ApplyPatchFileReader,
): Tool<unknown>[] {
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || capabilityTool.name !== "apply_patch") {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    const read = async (path: string): Promise<string | null> => {
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };
    type InvokeArgs = Parameters<FunctionTool["invoke"]>;
    const applyOne = async (
      runContext: InvokeArgs[0],
      operation: RobustPatchOperation,
      details: InvokeArgs[2],
    ): Promise<string> =>
      outputText(await invoke(runContext, JSON.stringify({ operations: [operation] }), details));
    return {
      ...capabilityTool,
      invoke: async (runContext, input, details) => {
        const patch = typeof input === "string" ? patchOf(input) : null;
        const operations = patch === null ? null : parseRobustPatch(patch);
        if (!operations) return await invoke(runContext, input, details);
        const results: { operation: RobustPatchOperation; output: string }[] = [];
        for (const operation of operations) {
          let output = await applyOne(runContext, operation, details);
          const failure = CONTEXT_FAILURE.exec(output);
          if (failure && operation.type === "update_file") {
            const content = await read(operation.path);
            const reordered = content === null ? null : reorderHunksByFile(content, operation.diff);
            const retried = reordered
              ? await applyOne(runContext, { ...operation, diff: reordered }, details)
              : null;
            if (retried === "Patch applied.") {
              output = retried;
            } else if (content !== null) {
              const context = output.slice(failure[0].length).split("\n");
              output = `${output.trimEnd()}\n${closestContextRegion(content, context, operation.path)}`;
            }
          }
          results.push({ operation, output: output || APPLIED });
        }
        const applied = results.filter((result) => result.output === APPLIED).length;
        if (results.length === 1 && applied === 1) return APPLIED;
        const lines = results.map((result) => labelSectionResult(result.operation, result.output));
        if (applied > 0 && applied < results.length) lines.push(PARTIAL_APPLY_NOTE);
        return lines.join("\n");
      },
    };
  });
}

type CapabilityLike = {
  tools(): Tool<unknown>[];
};

type ReadableSession = {
  readFile?(args: { path: string; runAs?: string }): Promise<string | Uint8Array>;
};

const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * Make the filesystem capability's function `apply_patch` robust. Install it
 * after the other filesystem wrappers and before `linkApplyPatchThen`, so
 * `then` is split off first. `Capability.clone()` copies this override onto
 * every per-run instance, which reads files from its own bound session.
 */
export function linkApplyPatchRobust(filesystem: CapabilityLike): void {
  const filesystemTools = filesystem.tools;
  filesystem.tools = function (this: CapabilityLike & { _session?: unknown; _runAs?: string }) {
    const session = this._session as ReadableSession | undefined;
    const runAs = this._runAs;
    return withApplyPatchRobust(filesystemTools.call(this), async (path) => {
      if (!session?.readFile) return null;
      const data = await session.readFile({ path, ...(runAs ? { runAs } : {}) });
      const bytes = typeof data === "string" ? data.length : data.byteLength;
      if (bytes > MAX_READ_BYTES) return null;
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    });
  };
}
