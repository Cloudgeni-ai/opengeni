import type { GitFileDiff } from "@opengeni/sdk";
import { stringifyPayload, tryParseJson } from "../lib/format";
import {
  applyPatchOpsFromToolItem,
  controlCaret,
  execTruncated,
  isExecSessionLostBanner,
  looksBinary,
  parseExecBannerSessionId,
  parseToolArgs,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
  v4aToGitFileDiff,
  type ApplyPatchOperation,
} from "./parsers";
import { rawTypeOf } from "./registry";
import { mcpToolLeaf, toolDisplayName } from "./tool-display-name";
import type { ToolCallItem } from "./types";

/* ----------------------------------------------------------------------------
   Tool row presentation model (renderer-neutral)

   The collapsed-row decisions every tool renderer makes — icon, tint, title,
   preview, settle chip and what the expanded body holds — expressed as plain
   data so DOM and non-DOM renderers draw the same row from one source of truth.
   Web renderers consume these functions; a change here changes every surface.
   -------------------------------------------------------------------------- */

export type ToolIconKind =
  | "terminal"
  | "keyboard"
  | "file-diff"
  | "search"
  | "question"
  | "target"
  | "brain"
  | "sessions"
  | "server"
  | "server-cog"
  | "calendar"
  | "panels"
  | "share"
  | "message"
  | "git"
  | "box"
  | "key"
  | "file-search"
  | "package-search"
  | "plug"
  | "wrench";

export type ToolIconTone = "accent" | "failed" | "running" | "muted";

export type ToolChip = {
  tone: "ok" | "bad" | "muted" | "interrupted";
  text: string;
};

/** The collapsed-row secondary line. `running` previews carry the pulse locus. */
export type ToolPreview =
  | { kind: "text"; text: string; running?: boolean | undefined }
  | {
      kind: "path";
      path: string;
      add?: number | undefined;
      del?: number | undefined;
    }
  | { kind: "files"; count: number; add: number; del: number }
  | { kind: "malformed"; name: string };

export type ToolPatchFile = {
  key: string;
  path: string;
  file: GitFileDiff | null;
  diff: string;
};

export type WebSearchResult = {
  title: string;
  domain: string;
  snippet: string;
};

/** What the expanded body holds; renderers draw these with their own primitives. */
export type ToolBody =
  | {
      kind: "term";
      command: string | null;
      workdir: string | null;
      output: string;
      live?: boolean | undefined;
      failed?: boolean | undefined;
      note?: string | undefined;
    }
  | { kind: "note"; text: string; tone?: "error" | undefined }
  | {
      kind: "payloads";
      blocks: Array<{ label: string; value: unknown; failed?: boolean }>;
    }
  | {
      kind: "patch";
      files: ToolPatchFile[];
      /** A single malformed op renders its raw patch without the path caption. */
      bare?: boolean | undefined;
    }
  | { kind: "web-results"; results: WebSearchResult[] | null };

export type PresentedToolKind =
  | "exec"
  | "write_stdin"
  | "apply_patch"
  | "web_search"
  | "ask"
  | "run_on"
  | "generic";

export type ToolRowPresentation = {
  tool: PresentedToolKind;
  icon: ToolIconKind;
  iconTone: ToolIconTone;
  title: string;
  titleMono?: boolean | undefined;
  running?: boolean | undefined;
  preview?: ToolPreview | undefined;
  chip?: ToolChip | undefined;
  failed?: boolean | undefined;
  cancelled?: boolean | undefined;
  body: ToolBody;
};

export type ToolPresentationContext = {
  /** Host-supplied active compute label ("on <label> · …" preview prefix). */
  computeLabel?: string | null | undefined;
};

/** Prefix a collapsed preview with the host-supplied active compute label. */
export function withComputePreview(label: string | null | undefined, preview: string): string {
  if (!label) {
    return preview;
  }
  return `on ${label} · ${preview}`;
}

export function truncatePreview(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function textPreview(text: string, running?: boolean): ToolPreview {
  return running ? { kind: "text", text, running: true } : { kind: "text", text };
}

/* ---- exec_command ---------------------------------------------------------- */

export function execPresentation(
  item: ToolCallItem,
  context: ToolPresentationContext = {},
): ToolRowPresentation {
  const args = parseToolArgs(item.arguments);
  const cmd = typeof args.cmd === "string" ? args.cmd : "";
  const workdir = typeof args.workdir === "string" ? args.workdir : null;
  const out = item.output;
  const title = `$ ${cmd}`;
  const computeLabel = context.computeLabel ?? null;
  const base = {
    tool: "exec" as const,
    icon: "terminal" as const,
    title,
    titleMono: true,
  };

  // No output event ever arrived: the turn failed before the output insert —
  // most likely a NUL byte in the command output prevented storage.
  if (item.status === "failed" && out === undefined) {
    return {
      ...base,
      iconTone: "failed",
      chip: { tone: "bad", text: "failed" },
      preview: textPreview(
        withComputePreview(computeLabel, "output lost — NUL byte could not be stored"),
      ),
      body: {
        kind: "note",
        tone: "error",
        text: "output contained a NUL byte and could not be stored; the turn failed on this tool's output insert — no output event ever arrived.",
      },
    };
  }

  if (item.status === "failed" && (out == null || out === "")) {
    return {
      ...base,
      iconTone: "failed",
      chip: { tone: "bad", text: "failed" },
      preview: textPreview(withComputePreview(computeLabel, "tool call failed")),
      body: {
        kind: "note",
        tone: "error",
        text: "the tool call failed with no output.",
      },
    };
  }

  if (item.status === "running") {
    const streamed = typeof out === "string" ? stripExecBanner(out) : "";
    const runningPreview = streamed ? `${streamed.split("\n").length} lines` : "running…";
    return {
      ...base,
      iconTone: "running",
      running: true,
      preview: textPreview(withComputePreview(computeLabel, runningPreview), true),
      body: {
        kind: "term",
        command: null,
        workdir,
        output: streamed,
        live: true,
      },
    };
  }

  const text = typeof out === "string" ? out : stringifyPayload(out);
  const stripped = stripExecBanner(text);
  const bgSession = parseExecBannerSessionId(text);
  const exitCode = sandboxCommandExitCode(text);
  const binary = looksBinary(stripped);

  // Color is spent on the exception only: a clean exit earns no chip.
  let chip: ToolChip | undefined;
  let iconTone: ToolIconTone = "muted";
  if (bgSession != null) {
    chip = { tone: "muted", text: `session ${bgSession}` };
  } else if (exitCode != null && exitCode !== 0) {
    chip = { tone: "bad", text: `exit ${exitCode}` };
    iconTone = "failed";
  }

  const peek = binary ? "binary output" : tailPeek(stripped) || "(no output)";
  const truncated = execTruncated(text);
  const preview = withComputePreview(computeLabel, truncated ? `⋯ truncated · ${peek}` : peek);
  return {
    ...base,
    iconTone,
    ...(chip ? { chip } : {}),
    failed: item.status === "failed",
    cancelled: item.status === "cancelled",
    preview: textPreview(preview),
    body: {
      kind: "term",
      command: null,
      workdir,
      output: binary ? "(binary output suppressed)" : stripped,
      failed: item.status === "failed" || (exitCode != null && exitCode !== 0),
      ...(bgSession != null
        ? {
            note: `↳ session ${bgSession} — a later write_stdin can target this PTY.`,
          }
        : {}),
    },
  };
}

/* ---- write_stdin ----------------------------------------------------------- */

export function writeStdinPresentation(item: ToolCallItem): ToolRowPresentation {
  const args = parseToolArgs(item.arguments);
  const sessionId =
    typeof args.session_id === "string" || typeof args.session_id === "number"
      ? args.session_id
      : undefined;
  const text = typeof item.output === "string" ? item.output : stringifyPayload(item.output);
  const lost = isExecSessionLostBanner(text);
  const keys = controlCaret(typeof args.chars === "string" ? args.chars : "");
  const exitCode = sandboxCommandExitCode(text);
  const stripped = stripExecBanner(text);
  const title = `session ${sessionId} ← ${keys || "∅"}`;
  const base = {
    tool: "write_stdin" as const,
    icon: "keyboard" as const,
    title,
    titleMono: true,
  };

  if (item.status === "running") {
    return {
      ...base,
      iconTone: "running",
      running: true,
      preview: textPreview("sending…", true),
      body: { kind: "note", text: `sending input to session ${sessionId}…` },
    };
  }

  let chip: ToolChip | undefined;
  if (lost) {
    chip = { tone: "bad", text: "lost" };
  } else if (exitCode != null && exitCode !== 0) {
    chip = { tone: "bad", text: `exit ${exitCode}` };
  }

  return {
    ...base,
    iconTone: lost ? "failed" : "muted",
    ...(chip ? { chip } : {}),
    failed: item.status === "failed",
    cancelled: item.status === "cancelled",
    preview: textPreview(lost ? `session ${sessionId} PTY vanished` : tailPeek(stripped) || "sent"),
    body: lost
      ? { kind: "note", tone: "error", text: stripped || text }
      : {
          kind: "term",
          command: `write_stdin → session ${sessionId}`,
          workdir: null,
          output: stripped,
        },
  };
}

/* ---- apply_patch ----------------------------------------------------------- */

export function patchVerb(op: ApplyPatchOperation | undefined): string {
  if (!op) {
    return "Edited";
  }
  return op.type === "create_file"
    ? "Created"
    : op.type === "delete_file"
      ? "Deleted"
      : op.moveTo
        ? "Renamed"
        : "Edited";
}

export function pathBasename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

export function pathDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

export function safeParsePatchOp(op: ApplyPatchOperation): GitFileDiff | null {
  try {
    return v4aToGitFileDiff(op);
  } catch {
    return null;
  }
}

function patchFiles(
  ops: ApplyPatchOperation[],
  parsed?: Array<GitFileDiff | null>,
): ToolPatchFile[] {
  return ops.map((op, index) => ({
    key: `${op.type}:${op.path}:${index}`,
    path: op.path,
    file: parsed ? (parsed[index] ?? null) : safeParsePatchOp(op),
    diff: op.diff ?? "",
  }));
}

/** Returns null when a settled patch has no op (renderers fall back to generic). */
export function applyPatchPresentation(item: ToolCallItem): ToolRowPresentation | null {
  const ops = applyPatchOpsFromToolItem(item);
  const cancelled = item.status === "cancelled";
  const firstOp = ops[0];
  const base = { tool: "apply_patch" as const, icon: "file-diff" as const };

  if (item.status === "running") {
    // Show the patch structure from the arguments, marked clearly in-progress.
    const fileCount = ops.length;
    const titleVerb = firstOp ? `Applying ${pathBasename(firstOp.path)}` : "Applying patch";
    return {
      ...base,
      iconTone: "running",
      title: fileCount > 1 ? `Applying ${fileCount} files` : titleVerb,
      running: true,
      preview: textPreview(
        fileCount > 1 ? `${fileCount} files` : firstOp ? firstOp.path : "applying…",
        true,
      ),
      body: { kind: "patch", files: patchFiles(ops) },
    };
  }

  if (item.status === "failed") {
    return {
      ...base,
      iconTone: "failed",
      title: firstOp ? `${patchVerb(firstOp)} ${pathBasename(firstOp.path)}` : "apply_patch",
      chip: { tone: "bad", text: "failed" },
      preview: textPreview(typeof item.output === "string" ? item.output : "patch failed"),
      body: {
        kind: "payloads",
        blocks: [{ label: "Error", value: item.output, failed: true }],
      },
    };
  }

  // Multi-file edit: magnitude stays a single muted glyph pair.
  if (ops.length > 1) {
    const parsed = ops.map((op) => safeParsePatchOp(op));
    const goodFiles = parsed.filter((f): f is GitFileDiff => f !== null);
    const add = goodFiles.reduce((n, f) => n + f.additions, 0);
    const del = goodFiles.reduce((n, f) => n + f.deletions, 0);
    return {
      ...base,
      iconTone: "accent",
      title: `Edited ${ops.length} files`,
      cancelled,
      preview: { kind: "files", count: ops.length, add, del },
      body: { kind: "patch", files: patchFiles(ops, parsed) },
    };
  }

  if (!firstOp) {
    return null;
  }
  if (firstOp.type === "delete_file") {
    return {
      ...base,
      iconTone: "failed",
      title: `Deleted ${pathBasename(firstOp.path)}`,
      cancelled,
      preview: { kind: "path", path: firstOp.path },
      body: { kind: "note", text: "File deleted — no diff to show." },
    };
  }

  const file = safeParsePatchOp(firstOp);
  if (!file) {
    return {
      ...base,
      iconTone: "accent",
      title: `${patchVerb(firstOp)} ${pathBasename(firstOp.path)}`,
      cancelled,
      preview: { kind: "malformed", name: pathBasename(firstOp.path) },
      body: { kind: "patch", files: patchFiles([firstOp], [null]), bare: true },
    };
  }

  return {
    ...base,
    iconTone: "accent",
    title: `${patchVerb(firstOp)} ${pathBasename(file.path)}`,
    cancelled,
    preview: {
      kind: "path",
      path: file.path,
      add: file.additions,
      del: file.deletions,
    },
    body: { kind: "patch", files: patchFiles([firstOp], [file]) },
  };
}

/* ---- web search ------------------------------------------------------------ */

export function webSearchQueryFromArguments(args: unknown): string | null {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return webSearchQueryFromArguments(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (!args || typeof args !== "object") {
    return null;
  }
  const record = args as Record<string, unknown>;
  if (typeof record.query === "string" && record.query.trim().length > 0) {
    return record.query;
  }
  if (Array.isArray(record.queries)) {
    const first = record.queries.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (first) {
      return first;
    }
  }
  return null;
}

export function webSearchPresentation(item: ToolCallItem): ToolRowPresentation {
  const raw = (item.raw ?? {}) as {
    providerData?: {
      action?: {
        type?: string;
        query?: string;
        queries?: string[];
        url?: string;
        pattern?: string;
      };
    };
  };
  const action = raw.providerData?.action ?? {};
  const actionType = action.type ?? "search";
  const queries = (action.queries ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const searchQuery =
    (typeof action.query === "string" && action.query.trim().length > 0 ? action.query : null) ??
    queries[0] ??
    webSearchQueryFromArguments(item.arguments);
  const running = item.status === "running";
  const query =
    actionType === "open_page"
      ? (action.url ?? "(page unavailable)")
      : actionType === "find_in_page"
        ? action.pattern && action.url
          ? `"${action.pattern}" in ${action.url}`
          : (action.pattern ?? action.url ?? "(page unavailable)")
        : // Codex often emits the live card before action.query/queries land.
          (searchQuery ?? (running ? "…" : "(query unavailable)"));
  const variants = queries.length > 1 ? ` +${queries.length - 1} variants` : "";
  const base = { tool: "web_search" as const, icon: "search" as const };

  if (running) {
    return {
      ...base,
      iconTone: "running",
      title:
        actionType === "open_page"
          ? "Opening web page"
          : actionType === "find_in_page"
            ? "Searching within page"
            : "Searching the web",
      running: true,
      preview: textPreview(`${query}${variants}`, true),
      body: {
        kind: "note",
        text: "searching… results fold into the model context (no output event).",
      },
    };
  }

  const rawResults = (item.output as { results?: unknown } | undefined)?.results;
  const results = Array.isArray(rawResults)
    ? (rawResults as unknown[]).filter((r): r is WebSearchResult => !!r && typeof r === "object")
    : null;
  return {
    ...base,
    iconTone: "muted",
    title:
      actionType === "open_page"
        ? "Opened web page"
        : actionType === "find_in_page"
          ? "Searched within page"
          : "Searched the web",
    preview: textPreview(`${query}${variants}`),
    failed: item.status === "failed",
    cancelled: item.status === "cancelled",
    body: { kind: "web-results", results },
  };
}

/* ---- MCP-shaped tools: ask, run_on, generic -------------------------------- */

export function askToolPreview(args: unknown): string | null {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const questions = Array.isArray(record?.questions) ? record.questions : null;
  if (!questions || questions.length === 0) {
    return null;
  }
  const first = questions[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const q = first as Record<string, unknown>;
  const text =
    typeof q.label === "string" && q.label.trim()
      ? q.label.trim()
      : typeof q.prompt === "string" && q.prompt.trim()
        ? q.prompt.trim()
        : null;
  if (!text) {
    return null;
  }
  const preview = truncatePreview(text, 90);
  return questions.length > 1 ? `${preview} · ${questions.length} questions` : preview;
}

export function runOnTargetName(output: unknown): string | null {
  const { text } = unwrapMcpOutput(output);
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const name = (parsed as { targetName?: unknown }).targetName;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return null;
}

export function runOnOpPreview(args: Record<string, unknown>): string | null {
  const op = args.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    return null;
  }
  const record = op as Record<string, unknown>;
  if (record.kind === "exec" && typeof record.cmd === "string" && record.cmd.trim()) {
    return `$ ${record.cmd.trim()}`;
  }
  if (
    (record.kind === "read" || record.kind === "write") &&
    typeof record.path === "string" &&
    record.path.trim()
  ) {
    return truncatePreview(record.path.trim(), 72);
  }
  return null;
}

export function goalToolPreview(name: string, args: unknown): string | null {
  const leaf = mcpToolLeaf(name);
  if (
    leaf !== "goal_set" &&
    leaf !== "goal_update" &&
    leaf !== "goal_complete" &&
    leaf !== "goal_pause" &&
    leaf !== "wait_for_input"
  ) {
    return null;
  }
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.evidence === "string"
        ? record.evidence
        : typeof record.rationale === "string"
          ? record.rationale
          : typeof record.reason === "string"
            ? record.reason
            : typeof record.progressNote === "string"
              ? record.progressNote
              : null;
  return text ? truncatePreview(text, 90) : null;
}

/** Explicit first-party leaf/prefix → canonical product icon kind. */
export function genericToolIconKind(name: string): ToolIconKind {
  const leaf = mcpToolLeaf(name);
  return leaf === "request_human_input"
    ? "question"
    : leaf.startsWith("goal_")
      ? "target"
      : leaf.startsWith("memory_") ||
          leaf === "preference_registry_summary" ||
          leaf === "preference_registry_get"
        ? "brain"
        : leaf.startsWith("session_") ||
            leaf === "sessions_list" ||
            leaf === "set_session_title" ||
            leaf === "set_other_session_title"
          ? "sessions"
          : leaf.startsWith("sandbox") || leaf === "sandboxes_list" || leaf === "run_on"
            ? "server"
            : leaf.startsWith("rig_")
              ? "server-cog"
              : leaf.startsWith("scheduled_")
                ? "calendar"
                : leaf.startsWith("artifacts_")
                  ? "panels"
                  : leaf.startsWith("social_")
                    ? "share"
                    : leaf.startsWith("slack_")
                      ? "message"
                      : leaf.startsWith("github_")
                        ? "git"
                        : leaf.startsWith("variable_")
                          ? "box"
                          : leaf.startsWith("environment_")
                            ? "key"
                            : leaf.includes("document") ||
                                leaf.includes("knowledge") ||
                                leaf === "list_document_bases"
                              ? "file-search"
                              : leaf === "tool_search"
                                ? "package-search"
                                : leaf.startsWith("skill_")
                                  ? "plug"
                                  : "wrench";
}

type McpRowOptions = {
  tool: PresentedToolKind;
  icon: ToolIconKind;
  title: string;
  /** Preview while running (falls back to `runningFallback`). */
  runningPreview: string | null;
  runningFallback: string;
  /** Settled preview (null → none); ask/run_on also use it as the error fallback. */
  settledPreview: string | null;
  /** Generic shows "Done" when no settled preview exists and skips the error fallback. */
  settledFallback?: string | undefined;
  /** Ask/run_on omit an empty Result block. */
  omitEmptyResult?: boolean | undefined;
  /** Generic shows a goal preview as plain text (no pulse) while running. */
  plainRunningPreview?: boolean | undefined;
};

function mcpRowPresentation(item: ToolCallItem, options: McpRowOptions): ToolRowPresentation {
  const args = parseToolArgs(item.arguments);
  const base = { tool: options.tool, icon: options.icon, title: options.title };
  if (item.status === "running") {
    return {
      ...base,
      iconTone: "running",
      running: true,
      preview:
        options.runningPreview != null && options.plainRunningPreview
          ? textPreview(options.runningPreview)
          : textPreview(options.runningPreview ?? options.runningFallback, true),
      body: { kind: "payloads", blocks: [{ label: "Arguments", value: args }] },
    };
  }
  const { text: outText, isError } = unwrapMcpOutput(item.output);
  // Cancelled is not an error, even if the payload carries an isError flag.
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    const errorFallback = options.settledFallback === undefined ? options.settledPreview : null;
    return {
      ...base,
      iconTone: "failed",
      chip: { tone: "bad", text: "error" },
      preview: textPreview(truncatePreview(outText, 80) || errorFallback || "Error"),
      body: {
        kind: "payloads",
        blocks: [
          { label: "Arguments", value: args },
          { label: "Error", value: outText, failed: true },
        ],
      },
    };
  }
  const settled =
    item.status === "cancelled"
      ? null
      : (options.settledPreview ?? options.settledFallback ?? null);
  return {
    ...base,
    iconTone: "muted",
    cancelled: item.status === "cancelled",
    ...(settled != null ? { preview: textPreview(settled) } : {}),
    body: {
      kind: "payloads",
      blocks:
        options.omitEmptyResult && !outText
          ? [{ label: "Arguments", value: args }]
          : [
              { label: "Arguments", value: args },
              { label: "Result", value: outText },
            ],
    },
  };
}

export function askPresentation(item: ToolCallItem): ToolRowPresentation {
  const preview = askToolPreview(parseToolArgs(item.arguments));
  return mcpRowPresentation(item, {
    tool: "ask",
    icon: "question",
    title: "Ask",
    runningPreview: preview,
    runningFallback: "Waiting…",
    settledPreview: preview,
    omitEmptyResult: true,
  });
}

export function runOnPresentation(item: ToolCallItem): ToolRowPresentation {
  const targetName = runOnTargetName(item.output);
  const opPreview = runOnOpPreview(parseToolArgs(item.arguments));
  return mcpRowPresentation(item, {
    tool: "run_on",
    icon: "server",
    title: targetName ? `Run on ${targetName}` : "Run on",
    runningPreview: opPreview,
    runningFallback: "Running…",
    settledPreview: opPreview,
    omitEmptyResult: true,
  });
}

/**
 * Baseline craft for unmatched tools: family icon + title-cased leaf + honest
 * status preview (Running… / Done / error snippet).
 */
export function genericToolPresentation(item: ToolCallItem): ToolRowPresentation {
  const goalPreview = goalToolPreview(item.name, parseToolArgs(item.arguments));
  return mcpRowPresentation(item, {
    tool: "generic",
    icon: genericToolIconKind(item.name),
    title: toolDisplayName(item.name, item.display),
    runningPreview: goalPreview,
    runningFallback: "Running…",
    settledPreview: goalPreview,
    settledFallback: "Done",
    plainRunningPreview: true,
  });
}

/* ---- resolution ------------------------------------------------------------ */

const PRESENTERS_BY_RAW_TYPE: Record<string, PresentedToolKind> = {
  apply_patch_call: "apply_patch",
  // Web renders these with richer media renderers; keep them off name matches.
  computer_call: "generic",
  tool_search_call: "generic",
};

const PRESENTERS_BY_NAME: Record<string, PresentedToolKind> = {
  exec_command: "exec",
  request_human_input: "ask",
  run_on: "run_on",
  write_stdin: "write_stdin",
  apply_patch_call: "apply_patch",
  apply_patch: "apply_patch",
  web_search_call: "web_search",
};

/**
 * Resolve the shared presenter for a call with the web registry's precedence
 * (raw.type, exact name, MCP leaf). Tools whose web renderer is richer than the
 * shared model (computer use, media, knowledge receipts, …) resolve to
 * `generic`; non-DOM renderers may layer their own presenters on top.
 */
export function presentedToolKind(item: ToolCallItem): PresentedToolKind {
  const rawType = rawTypeOf(item);
  if (rawType && PRESENTERS_BY_RAW_TYPE[rawType]) {
    return PRESENTERS_BY_RAW_TYPE[rawType];
  }
  const exact = PRESENTERS_BY_NAME[item.name];
  if (exact) {
    return exact;
  }
  const leaf = mcpToolLeaf(item.name);
  if (leaf !== item.name && PRESENTERS_BY_NAME[leaf]) {
    return PRESENTERS_BY_NAME[leaf];
  }
  return "generic";
}

export function toolRowPresentation(
  item: ToolCallItem,
  context: ToolPresentationContext = {},
): ToolRowPresentation {
  switch (presentedToolKind(item)) {
    case "exec":
      return execPresentation(item, context);
    case "write_stdin":
      return writeStdinPresentation(item);
    case "apply_patch":
      return applyPatchPresentation(item) ?? genericToolPresentation(item);
    case "web_search":
      return webSearchPresentation(item);
    case "ask":
      return askPresentation(item);
    case "run_on":
      return runOnPresentation(item);
    default:
      return genericToolPresentation(item);
  }
}
