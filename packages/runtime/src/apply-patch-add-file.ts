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

/**
 * Rewrite a freeform `*** Begin Patch` payload so each non-empty Add File
 * section ends with one extra empty `+` line. Line splitting and section
 * boundaries match the SDK parser exactly; a payload the SDK would reject is
 * returned unchanged so it keeps the SDK's own error.
 */
export function withCodexAddFilePatch(patch: string): string {
  const trimmed = patch.trimStart();
  const lines = trimmed.split(/\r?\n/);
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
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
