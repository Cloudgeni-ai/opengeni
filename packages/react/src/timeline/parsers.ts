import { normalizeMcpOutput, type GitFileDiff } from "@opengeni/sdk";
import { tryParseJson } from "../lib/format";

/* ----------------------------------------------------------------------------
   Pure parsers for the provider-native tool shapes that the timeline renders.

   These are intentionally browser-safe, dependency-free mirrors of the
   server-side helpers in `@opengeni/runtime` (`sandboxCommandExitCode`,
   `parseExecBannerSessionId`, `stripExecBanner`) plus the V4A diff parser the
   apply-patch renderer needs. The SDK does not depend on `@opengeni/runtime` by
   design (runtime is a heavy server package); these few regexes are cheap to
   own here and keep the React surface free of a server dependency.

   Every function is pure -- same input, same output -- so it can be
   unit-tested and memoized.
   -------------------------------------------------------------------------- */

/** Recover the exit code from a sandbox exec banner (`Process exited with code N`). */
export function sandboxCommandExitCode(out: unknown): number | null {
  const match = String(out ?? "").match(/Process exited with code (-?\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Recover the numeric exec-session id the sandbox embeds for a STILL-RUNNING
 * (backgrounded) process (`Process running with session ID N`). A finished
 * command emits `Process exited with code N` instead, which yields `null`.
 */
export function parseExecBannerSessionId(out: unknown): number | null {
  const text = String(out ?? "");
  const outputIdx = text.indexOf("\nOutput:\n");
  const banner =
    outputIdx >= 0 ? text.slice(0, outputIdx) : text.startsWith("Output:\n") ? "" : text;
  const match = banner.match(/Process running with session ID (\d+)/);
  if (!match) {
    return null;
  }
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** Strip the exec banner (`Chunk ID ...\n...\nOutput:\n`) down to the command's stdout. */
export function stripExecBanner(out: unknown): string {
  const text = String(out ?? "");
  const marker = text.indexOf("\nOutput:\n");
  if (marker >= 0) {
    return text.slice(marker + "\nOutput:\n".length);
  }
  if (text.startsWith("Output:\n")) {
    return text.slice("Output:\n".length);
  }
  return text;
}

/** The sandbox clamped the output (token/line truncation markers in the banner). */
export function execTruncated(out: unknown): boolean {
  return /Total output lines:|\.{3}\d+ tokens truncated\.{3}|\[\.{3}\d+ characters truncated/.test(
    String(out ?? ""),
  );
}

/** A `write_stdin` whose target PTY vanished (`write_stdin failed: session not found: N`). */
export function isExecSessionLostBanner(out: unknown): boolean {
  return /write_stdin failed: session not found: \d+/.test(String(out ?? ""));
}

/** True when the exec stdout looks binary/garbled (a NUL byte or ELF magic). */
export function looksBinary(text: string): boolean {
  return text.includes("\u0000") || text.startsWith("\u007fELF");
}

/**
 * Render unprintable control characters as caret notation (0x03 -> `^C`) so a
 * `write_stdin` keystroke payload reads cleanly in the row title.
 */
export function controlCaret(printable: string): string {
  return String(printable).replace(
    /[\u0000-\u001f]/g,
    (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`,
  );
}

/* --- V4A apply_patch diff -> GitFileDiff ------------------------------------ */

/** One operation inside an `apply_patch_call` (a V4A file edit). */
export type ApplyPatchOperation = {
  /**
   * The V4A op kind. The three canonical values are `create_file`,
   * `update_file`, and `delete_file`; the open `string` tail tolerates a
   * forward-compatible/unknown op kind from the provider without a type error
   * (it falls through to the "Edited" treatment).
   */
  type: "create_file" | "update_file" | "delete_file" | (string & {});
  path: string;
  /** Rename target -- when present the op is a move/rename. */
  moveTo?: string | null | undefined;
  /** The V4A hunk string (`@@ ...` lines with `+`/`-`/context prefixes). */
  diff?: string | undefined;
};

/**
 * Parse a single V4A `apply_patch` operation into the SDK's `GitFileDiff` shape
 * so it can flow into the SAME `DiffView` / `PierreDiff` the Files tab uses.
 * Throws on a hunk string it cannot structure (no `@@` anchor on an update); the
 * renderer catches and falls back to a raw-patch view.
 */
export function v4aToGitFileDiff(op: ApplyPatchOperation): GitFileDiff {
  const status: GitFileDiff["status"] =
    op.type === "create_file"
      ? "added"
      : op.type === "delete_file"
        ? "deleted"
        : op.moveTo
          ? "renamed"
          : "modified";
  const oldPath = op.moveTo ? op.path : null;
  const path = op.moveTo || op.path;

  const hunks: GitFileDiff["hunks"] = [];
  let additions = 0;
  let deletions = 0;
  let sawHunkAnchor = false;

  if (op.type !== "delete_file") {
    const lines = (op.diff ?? "").split("\n");
    let cur: GitFileDiff["hunks"][number] | null = null;
    let oldNo = 1;
    let newNo = 1;
    for (const raw of lines) {
      if (raw.startsWith("@@")) {
        sawHunkAnchor = true;
        const match = raw.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
        oldNo = match ? Number(match[1]) : 1;
        newNo = match ? Number(match[2]) : 1;
        cur = {
          oldStart: oldNo,
          oldLines: 0,
          newStart: newNo,
          newLines: 0,
          header: raw,
          lines: [{ type: "meta", oldNo: null, newNo: null, text: raw }],
        };
        hunks.push(cur);
      } else if (cur || op.type === "create_file") {
        if (!cur) {
          // No `@@` anchor on a create_file body: synthesize an add-only hunk.
          // Leave `header` empty so `gitFileDiffToPatch` regenerates a valid
          // `@@ -0,0 +1,N @@` from the range fields once newLines is counted — a
          // pre-baked partial header (e.g. `@@ +1 @@`) renders zero lines in a
          // generic unified-diff parser.
          cur = {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 0,
            header: "",
            lines: [],
          };
          hunks.push(cur);
          oldNo = 0;
          newNo = 1;
        }
        if (raw.startsWith("+")) {
          cur.lines.push({
            type: "add",
            oldNo: null,
            newNo: newNo++,
            text: raw.slice(1),
          });
          cur.newLines += 1;
          additions += 1;
        } else if (raw.startsWith("-")) {
          cur.lines.push({
            type: "del",
            oldNo: oldNo++,
            newNo: null,
            text: raw.slice(1),
          });
          cur.oldLines += 1;
          deletions += 1;
        } else {
          cur.lines.push({
            type: "context",
            oldNo: oldNo++,
            newNo: newNo++,
            text: raw.replace(/^ /, ""),
          });
          cur.oldLines += 1;
          cur.newLines += 1;
        }
      }
    }
    // An update with content but no recognizable hunk anchor is malformed V4A;
    // the caller falls back to the raw-patch view instead of a structured diff.
    if (op.type === "update_file" && !sawHunkAnchor && lines.some((l) => l.trim().length > 0)) {
      throw new Error("malformed V4A: no @@ hunk anchor");
    }
  }

  return {
    path,
    oldPath,
    status,
    isBinary: false,
    isImage: false,
    additions,
    deletions,
    hunks,
    truncated: false,
  };
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";

const APPLY_PATCH_OP_TYPES = new Set(["create_file", "update_file", "delete_file"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Freeform / `{ patch }` / command payloads — tolerate leading whitespace. */
function freeformApplyPatchOps(rawPatch: string): ApplyPatchOperation[] {
  return parseFreeformApplyPatch(rawPatch.trimStart());
}

function asApplyPatchOperation(value: unknown): ApplyPatchOperation | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== "string" || !APPLY_PATCH_OP_TYPES.has(value.type)) {
    return null;
  }
  if (typeof value.path !== "string" || !value.path) {
    return null;
  }
  const op: ApplyPatchOperation = {
    type: value.type as ApplyPatchOperation["type"],
    path: value.path,
  };
  if (typeof value.diff === "string") op.diff = value.diff;
  if (typeof value.moveTo === "string" && value.moveTo.length > 0) op.moveTo = value.moveTo;
  return op;
}

function parseStructuredOperations(payloads: unknown[]): ApplyPatchOperation[] {
  if (payloads.length === 0) return [];
  const operations: ApplyPatchOperation[] = [];
  for (const payload of payloads) {
    const op = asApplyPatchOperation(payload);
    if (!op) return [];
    operations.push(op);
  }
  return operations;
}

/**
 * Mirror of `@openai/agents-core` freeform `*** Begin Patch` → ops. Kept here so
 * the timeline can render Codex function-tool apply_patch without importing the
 * server SDK package.
 */
export function parseFreeformApplyPatch(rawPatch: string): ApplyPatchOperation[] {
  const lines = rawPatch.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== BEGIN_PATCH) return [];
  if (lines.length < 2 || lines.at(-1) !== END_PATCH) return [];

  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    let parsed: { operation: ApplyPatchOperation; nextIndex: number } | { error: true } | null =
      null;
    if (line.startsWith(ADD_FILE)) parsed = parseAddFilePatch(lines, index);
    else if (line.startsWith(DELETE_FILE)) parsed = parseDeleteFilePatch(lines, index);
    else if (line.startsWith(UPDATE_FILE)) parsed = parseUpdateFilePatch(lines, index);
    else return [];
    if (!parsed || "error" in parsed) return [];
    operations.push(parsed.operation);
    index = parsed.nextIndex;
  }
  // Match the SDK: Begin/End with no file ops is not a valid patch.
  return operations.length > 0 ? operations : [];
}

function parsePatchHeader(line: string, prefix: string): string | null {
  const path = line.slice(prefix.length).trim();
  return path || null;
}

function isFileOperationHeader(line: string): boolean {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function joinDiff(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function parseAddFilePatch(
  lines: string[],
  index: number,
): { operation: ApplyPatchOperation; nextIndex: number } | { error: true } {
  const path = parsePatchHeader(lines[index]!, ADD_FILE);
  if (!path) return { error: true };
  index += 1;
  const diffLines: string[] = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    const line = lines[index]!;
    if (!line.startsWith("+")) return { error: true };
    diffLines.push(line);
    index += 1;
  }
  if (diffLines.length === 0) return { error: true };
  return {
    operation: { type: "create_file", path, diff: joinDiff(diffLines) },
    nextIndex: index,
  };
}

function parseDeleteFilePatch(
  lines: string[],
  index: number,
): { operation: ApplyPatchOperation; nextIndex: number } | { error: true } {
  const path = parsePatchHeader(lines[index]!, DELETE_FILE);
  if (!path) return { error: true };
  index += 1;
  if (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    return { error: true };
  }
  return { operation: { type: "delete_file", path }, nextIndex: index };
}

function parseUpdateFilePatch(
  lines: string[],
  index: number,
): { operation: ApplyPatchOperation; nextIndex: number } | { error: true } {
  const path = parsePatchHeader(lines[index]!, UPDATE_FILE);
  if (!path) return { error: true };
  index += 1;
  let moveTo: string | undefined;
  if (index < lines.length - 1 && lines[index]!.startsWith(MOVE_TO)) {
    const parsedMoveTo = parsePatchHeader(lines[index]!, MOVE_TO);
    if (!parsedMoveTo) return { error: true };
    moveTo = parsedMoveTo;
    index += 1;
  }
  const diffLines: string[] = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    diffLines.push(lines[index]!);
    index += 1;
  }
  if (diffLines.length === 0 && !moveTo) return { error: true };
  return {
    operation: {
      type: "update_file",
      path,
      diff: diffLines.length > 0 ? joinDiff(diffLines) : "",
      ...(moveTo ? { moveTo } : {}),
    },
    nextIndex: index,
  };
}

/**
 * Normalize every apply_patch payload the Agents SDK accepts into structured
 * ops — hosted `{ operation }` / `{ operations }`, function-tool `{ patch }`,
 * `command` tuple, flat op, freeform string, or op array.
 */
export function applyPatchOps(raw: unknown): ApplyPatchOperation[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith(BEGIN_PATCH)) return freeformApplyPatchOps(trimmed);
    const parsed = tryParseJson(trimmed);
    return parsed === undefined ? [] : applyPatchOps(parsed);
  }
  if (Array.isArray(raw)) return parseStructuredOperations(raw);
  if (!isRecord(raw)) return [];

  if (typeof raw.patch === "string") return freeformApplyPatchOps(raw.patch);
  if (Array.isArray(raw.command)) {
    const [commandName, patch] = raw.command;
    if (commandName === "apply_patch" && typeof patch === "string") {
      return freeformApplyPatchOps(patch);
    }
  }
  // Empty `operations: []` is not authoritative — fall through to operation/flat.
  if (Array.isArray(raw.operations) && raw.operations.length > 0) {
    return parseStructuredOperations(raw.operations);
  }
  if (raw.operation !== undefined) {
    const op = asApplyPatchOperation(raw.operation);
    return op ? [op] : [];
  }
  // Flat single op: `{ type, path, diff?, moveTo? }`.
  const flat = asApplyPatchOperation(raw);
  return flat ? [flat] : [];
}

/** Ops from provider `raw` and/or function-tool arguments (Codex path). */
export function applyPatchOpsFromToolItem(item: {
  raw: unknown;
  arguments: unknown;
}): ApplyPatchOperation[] {
  const fromRaw = applyPatchOps(item.raw);
  if (fromRaw.length > 0) return fromRaw;

  // function_call envelopes sometimes keep the payload only under raw.arguments.
  if (isRecord(item.raw)) {
    const nested = item.raw.arguments ?? item.raw.input;
    if (nested !== undefined && nested !== item.arguments) {
      const fromNested = applyPatchOps(nested);
      if (fromNested.length > 0) return fromNested;
    }
  }

  if (item.arguments !== undefined && item.arguments !== null) {
    return applyPatchOps(item.arguments);
  }
  return [];
}

/**
 * True when a tool item is apply_patch — hosted `raw.type === "apply_patch_call"`,
 * function-tool `name` `apply_patch` / `apply_patch_call`, or an MCP-prefixed
 * `…__apply_patch` leaf. Centralizes the rawType-or-name check.
 */
export function isApplyPatch(item: { name: string; raw: unknown }): boolean {
  const type =
    item.raw && typeof item.raw === "object" ? (item.raw as { type?: unknown }).type : undefined;
  if (type === "apply_patch_call") {
    return true;
  }
  const name = item.name;
  return name === "apply_patch_call" || name === "apply_patch" || name.endsWith("__apply_patch");
}

/** Parse tool arguments that may arrive as a JSON string or an object. */
export function parseToolArgs(args: unknown): Record<string, unknown> {
  if (args == null) {
    return {};
  }
  if (typeof args === "string") {
    const parsed = tryParseJson(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }
  return typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/** The last non-empty line of a string -- the compact "what happened" peek. */
export function tailPeek(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split("\n");
  return lines[lines.length - 1] ?? "";
}

/**
 * Unwrap an MCP tool result (`{ content: [{ type: "text", text }], isError? }`)
 * into a flat `{ text, isError }`. Non-MCP outputs pass through as their string
 * form.
 */
export function unwrapMcpOutput(output: unknown): {
  text: string;
  isError: boolean;
} {
  const normalized = normalizeMcpOutput(output);
  return { text: normalized.text, isError: normalized.isError };
}

/* --- computer-use screenshot extraction ------------------------------------- */

/**
 * Extract a renderable `data:` URL from a computer-use screenshot output,
 * whatever transport produced it. The hosted `computer_call` and the
 * function-text mode persist a plain `data:image/...` string; the
 * function-image mode (codex-backed sessions) persists the STRUCTURED image
 * output — `{type:"image", image:{data, mediaType}}` with `data` arriving as a
 * number array / index map / Buffer-JSON / base64 string after event
 * serialization — or the agents-core normalized `input_image` content item.
 * Returns null when the output carries no image (so callers fall back to their
 * text/empty presentation).
 */
export function screenshotDataUrl(out: unknown): string | null {
  if (typeof out === "string") {
    if (out.startsWith("data:image")) {
      return out;
    }
    // A JSON-encoded structured output (some transports stringify tool results).
    if (out.startsWith("{") || out.startsWith("[")) {
      const parsed = tryParseJson(out);
      if (parsed !== undefined && parsed !== out) {
        return screenshotDataUrl(parsed);
      }
    }
    return null;
  }
  if (Array.isArray(out)) {
    for (const entry of out) {
      const url = screenshotDataUrl(entry);
      if (url) {
        return url;
      }
    }
    return null;
  }
  if (out === null || typeof out !== "object") {
    return null;
  }
  const record = out as Record<string, unknown>;
  // agents-core normalized content item: {type:"input_image", image_url: "data:…" | {url}}
  const imageUrl = record.image_url ?? record.imageUrl;
  if (typeof imageUrl === "string" && imageUrl.startsWith("data:image")) {
    return imageUrl;
  }
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url === "string" && url.startsWith("data:image")) {
      return url;
    }
  }
  // Structured tool output: {type:"image", image:{data, mediaType}}
  const image = record.image as Record<string, unknown> | undefined;
  if (image && typeof image === "object") {
    const mediaType = typeof image.mediaType === "string" ? image.mediaType : "image/png";
    const base64 = bytesToBase64(image.data);
    if (base64) {
      return `data:${mediaType};base64,${base64}`;
    }
    if (typeof image.data === "string" && image.data.length > 0) {
      // Already base64 text.
      return `data:${mediaType};base64,${image.data}`;
    }
  }
  return null;
}

export type TimelineMediaPreview = {
  type: "media_preview";
  mediaType: string;
  inlineBytes: number | null;
  fullOutputAvailable: false;
  preview: string;
};

/** Find the explicit non-retained inline-media fact in a tool output. */
export function mediaPreviewFact(out: unknown): TimelineMediaPreview | null {
  if (typeof out === "string" && (out.startsWith("{") || out.startsWith("["))) {
    const parsed = tryParseJson(out);
    if (parsed !== undefined && parsed !== out) return mediaPreviewFact(parsed);
  }
  if (Array.isArray(out)) {
    for (const entry of out) {
      const preview = mediaPreviewFact(entry);
      if (preview) return preview;
    }
    return null;
  }
  if (!out || typeof out !== "object") return null;
  const record = out as Record<string, unknown>;
  if (
    record.type !== "media_preview" ||
    typeof record.mediaType !== "string" ||
    record.fullOutputAvailable !== false ||
    typeof record.preview !== "string" ||
    (record.inlineBytes !== null && typeof record.inlineBytes !== "number")
  ) {
    return null;
  }
  return record as TimelineMediaPreview;
}

/** Serialize whatever a Uint8Array became in JSON (number[], {"0":n,…} index
 *  map, or Buffer-JSON {type:"Buffer",data:[…]}) back into base64. */
function bytesToBase64(data: unknown): string | null {
  const isByte = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
  let bytes: number[] | null = null;
  if (Array.isArray(data) && data.every(isByte)) {
    bytes = data;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data) && record.data.every(isByte)) {
      bytes = record.data;
    } else {
      const keys = Object.keys(record);
      if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
        const values = keys.sort((a, b) => Number(a) - Number(b)).map((key) => record[key]);
        if (values.every(isByte)) {
          bytes = values;
        }
      }
    }
  }
  if (!bytes || bytes.length === 0) {
    return null;
  }
  try {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
    }
    return typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  } catch {
    // A hostile/absurd payload must degrade to "no image", never crash a render.
    return null;
  }
}
