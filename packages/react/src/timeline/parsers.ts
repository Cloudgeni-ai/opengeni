import type { GitFileDiff } from "@opengeni/sdk";
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

/**
 * Extract the `apply_patch` operations from a provider-native tool item's `raw`
 * payload, normalizing the two wire shapes (`raw.operations[]` for a multi-file
 * patch, `raw.operation` for a single op). The single owner of this shape so the
 * renderer and the turn-summary facet counter never drift.
 */
export function applyPatchOps(raw: unknown): ApplyPatchOperation[] {
  const r = (raw ?? {}) as {
    operation?: ApplyPatchOperation;
    operations?: ApplyPatchOperation[];
  };
  if (Array.isArray(r.operations)) {
    return r.operations;
  }
  return r.operation ? [r.operation] : [];
}

/**
 * True when a tool item is an `apply_patch_call` — by its provider-native
 * `raw.type` (the live-wire source of truth) or by tool `name` (first-party
 * replays that omit `raw`). Centralizes the rawType-or-name check.
 */
export function isApplyPatch(item: { name: string; raw: unknown }): boolean {
  const type =
    item.raw && typeof item.raw === "object" ? (item.raw as { type?: unknown }).type : undefined;
  return type === "apply_patch_call" || item.name === "apply_patch_call";
}

/* --- secret redaction ------------------------------------------------------- */

const SECRET_KEY = /^(value|secret|token|password|api[_-]?key|signing[_-]?key)$/i;

/** Deep-redact secret-looking values so arguments never leak a key into the UI. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "••••" : redactSecrets(v);
    }
    return out;
  }
  return value;
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
  // Managed MCP events persist a normalized single text part as
  // `{ type: "text", text }`; accept it alongside the SDK-native content array.
  if (
    output &&
    typeof output === "object" &&
    (output as { type?: unknown }).type === "text" &&
    typeof (output as { text?: unknown }).text === "string"
  ) {
    const record = output as { text: string; isError?: unknown };
    return { text: record.text, isError: Boolean(record.isError) };
  }
  if (output && typeof output === "object" && "content" in output) {
    const record = output as { content?: unknown; isError?: unknown };
    const isError = Boolean(record.isError);
    if (Array.isArray(record.content)) {
      const textPart = record.content.find(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
      );
      return {
        text: textPart ? String(textPart.text) : JSON.stringify(output),
        isError,
      };
    }
    return { text: JSON.stringify(output), isError };
  }
  return {
    text: typeof output === "string" ? output : output == null ? "" : JSON.stringify(output),
    isError: false,
  };
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
