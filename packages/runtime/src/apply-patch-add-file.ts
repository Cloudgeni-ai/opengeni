/**
 * Codex `*** Add File` semantics for the SDK filesystem `apply_patch` tool.
 *
 * Codex's parser (`codex-rs/apply-patch`) appends `\n` after every `+` line of
 * an Add File section, so `+a` / `+b` creates `"a\nb\n"`. The Agents SDK's V4A
 * create mode joins the lines with `\n` and drops the final newline, so every
 * file the agent created lacked a trailing newline. Rather than change the
 * sandbox editors (internal writers such as Git credential staging and Codemode
 * client delivery rely on their exact-content `create_file` semantics), the
 * model-facing tool appends one empty `+` line to each non-empty Add File
 * section before the SDK applies it. Update and Delete sections are untouched.
 *
 * The same rewrite also repairs unambiguous framing slips that the SDK's
 * strict parser rejects and models (Claude in particular) make on long Add
 * File payloads, each of which otherwise costs a full resend of the patch:
 * a repeated trailing `*** End Patch`, an interior `*** End Patch` (optionally
 * with a new `*** Begin Patch`) before the next file section, a stray interior
 * `*** Begin Patch`, bare empty lines inside an Add File section, and Add File
 * content whose `+` prefixes stop after some line (see
 * `canPrefixAddFileSection`). Every repair applies only to input the SDK
 * would reject, so patches it accepts today parse exactly as before.
 */

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";

function isFileOperationHeader(line: string): boolean {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

/**
 * Rewrite a headerless V4A create diff (`+line` per line) so the SDK's create
 * mode yields Codex content: every line followed by `\n`. An empty diff stays
 * empty, like a Codex Add File section with no lines.
 */
export function withCodexAddFileDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return diff;
  return `${[...lines, "+"].join("\n")}\n`;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * Whether the Add File section starting at `start` dropped its `+` prefixes
 * from some line onward (often all but the first line), so prefixing the
 * unprefixed lines is the only reading. Once a line lacks the prefix, a later
 * `+` line is ambiguous (`++i;` or a `+ item` bullet may be content), and a
 * `@@` line means an Update hunk was sent under Add File; both are left for
 * the SDK to reject.
 */
function canPrefixAddFileSection(lines: readonly string[], start: number): boolean {
  let unprefixedSeen = false;
  for (let index = start; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (isFileOperationHeader(line) || line === END_PATCH) break;
    if (line === "" || line === BEGIN_PATCH) continue;
    if (line.startsWith("+")) {
      if (unprefixedSeen) return false;
    } else {
      if (line.startsWith("@@")) return false;
      unprefixedSeen = true;
    }
  }
  return true;
}

/**
 * Repair framing slips the SDK parser would reject but whose intent is
 * unambiguous. Expects `lines` to start with `*** Begin Patch`; returns a new
 * array. Valid content lines are never altered, so a file that legitimately
 * contains `*** End Patch` (written as `+*** End Patch`) is safe, and a stray
 * unprefixed `*** End Patch` is left for the SDK to reject.
 */
export function withLenientPatchFraming(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 1 && isBlank(lines[end - 1]!)) end -= 1;
  // A repeated trailing `*** End Patch` (blank lines between them included).
  while (end > 2 && lines[end - 1] === END_PATCH) {
    let previous = end - 2;
    while (previous > 0 && isBlank(lines[previous]!)) previous -= 1;
    if (lines[previous] !== END_PATCH) break;
    end = previous + 1;
  }
  const body = lines.slice(0, end);
  if (body.at(-1) !== END_PATCH) return [...lines];

  const output = [body[0]!];
  let inAddFile = false;
  let prefixRepairable = false;
  let pendingBlankAddLines = 0;
  for (let index = 1; index < body.length; index += 1) {
    const line = body[index]!;
    const isEnd = index === body.length - 1;
    if (!isEnd && line === END_PATCH) {
      // An interior End Patch is dropped only when another file section
      // follows (optionally behind a fresh Begin Patch).
      let next = index + 1;
      while (next < body.length - 1 && isBlank(body[next]!)) next += 1;
      if (body[next] === BEGIN_PATCH) {
        next += 1;
        while (next < body.length - 1 && isBlank(body[next]!)) next += 1;
      }
      if (next < body.length - 1 && isFileOperationHeader(body[next]!)) {
        pendingBlankAddLines = 0;
        index = next - 1;
        continue;
      }
    }
    const isHeader = !isEnd && isFileOperationHeader(line);
    if (isHeader || isEnd) {
      // Bare empty lines that end an Add File section are separators.
      pendingBlankAddLines = 0;
      inAddFile = isHeader && line.startsWith(ADD_FILE);
      prefixRepairable = inAddFile && canPrefixAddFileSection(body, index + 1);
      output.push(line);
      continue;
    }
    // A Begin Patch inside the body is never valid and carries no content.
    if (line === BEGIN_PATCH) continue;
    if (inAddFile && line === "") {
      pendingBlankAddLines += 1;
      continue;
    }
    if (inAddFile && (line.startsWith("+") || (prefixRepairable && line !== END_PATCH))) {
      for (; pendingBlankAddLines > 0; pendingBlankAddLines -= 1) output.push("+");
      output.push(line.startsWith("+") ? line : `+${line}`);
      continue;
    }
    output.push(line);
  }
  return output;
}

/**
 * Rewrite a freeform `*** Begin Patch` payload so each non-empty Add File
 * section ends with one extra empty `+` line, after repairing framing slips
 * (`withLenientPatchFraming`). Line splitting and section boundaries match the
 * SDK parser; a payload whose framing cannot be repaired is returned unchanged
 * so it keeps the SDK's own error.
 */
export function withCodexAddFilePatch(patch: string): string {
  const trimmed = patch.trimStart();
  const rawLines = trimmed.split(/\r?\n/);
  const trailingNewline = rawLines.at(-1) === "";
  if (rawLines[0] !== BEGIN_PATCH) return patch;
  const lines = withLenientPatchFraming(rawLines);
  if (lines[0] !== BEGIN_PATCH || lines.length < 2 || lines.at(-1) !== END_PATCH) return patch;
  const output = [lines[0]];
  let inAddFile = false;
  let addFileLines = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isEnd = index === lines.length - 1;
    const isHeader = !isEnd && isFileOperationHeader(line);
    if ((isHeader || isEnd) && inAddFile && addFileLines > 0) output.push("+");
    if (isHeader) {
      inAddFile = line.startsWith(ADD_FILE);
      addFileLines = 0;
    } else if (inAddFile && !isEnd) {
      addFileLines += 1;
    }
    output.push(line);
  }
  return `${output.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withCodexAddFileOperation(operation: unknown): unknown {
  if (
    isRecord(operation) &&
    operation.type === "create_file" &&
    typeof operation.diff === "string"
  ) {
    return { ...operation, diff: withCodexAddFileDiff(operation.diff) };
  }
  return operation;
}

/** Mirror the SDK's `parseApplyPatchPayload` dispatch over every accepted form. */
function withCodexAddFilePayload(payload: unknown): unknown {
  if (typeof payload === "string") return withCodexAddFilePatch(payload);
  if (Array.isArray(payload)) return payload.map(withCodexAddFileOperation);
  if (!isRecord(payload)) return payload;
  if (typeof payload.patch === "string") {
    return { ...payload, patch: withCodexAddFilePatch(payload.patch) };
  }
  if (Array.isArray(payload.command)) {
    const [commandName, patch, ...rest] = payload.command;
    if (commandName === "apply_patch" && typeof patch === "string") {
      return { ...payload, command: [commandName, withCodexAddFilePatch(patch), ...rest] };
    }
  }
  if (Array.isArray(payload.operations)) {
    return { ...payload, operations: payload.operations.map(withCodexAddFileOperation) };
  }
  if (payload.operation !== undefined) {
    return { ...payload, operation: withCodexAddFileOperation(payload.operation) };
  }
  return withCodexAddFileOperation(payload);
}

/**
 * Rewrite the raw function-tool input of the SDK `apply_patch` fallback. Input
 * that is not a recognizable payload is returned unchanged.
 */
export function withCodexAddFileApplyPatchInput(input: string): string {
  if (input.trimStart().startsWith(BEGIN_PATCH)) return withCodexAddFilePatch(input);
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return input;
  }
  const next = withCodexAddFilePayload(payload);
  return next === payload ? input : JSON.stringify(next);
}

type ApplyPatchEditorLike = {
  createFile: (
    operation: { diff: string } & Record<string, unknown>,
    ...rest: unknown[]
  ) => unknown;
  updateFile: (...args: unknown[]) => unknown;
  deleteFile: (...args: unknown[]) => unknown;
};

/** Wrap a hosted `apply_patch` editor so `create_file` gets Codex content. */
export function withCodexAddFileEditor<E>(editor: E): E {
  const inner = editor as unknown as ApplyPatchEditorLike;
  const wrapped: ApplyPatchEditorLike = {
    createFile: (operation, ...rest) =>
      inner.createFile({ ...operation, diff: withCodexAddFileDiff(operation.diff) }, ...rest),
    updateFile: (...args) => inner.updateFile(...args),
    deleteFile: (...args) => inner.deleteFile(...args),
  };
  return wrapped as unknown as E;
}
