import type {
  AttemptToolIdentity,
  AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";

type JsonRecord = Record<string, unknown>;

/**
 * The model-visible copy of a first-party `command_read` or `command_wait`
 * result: plain text with the command's state, exit code and output, like an
 * `exec_command` result, instead of the JSON receipt with per-chunk metadata.
 * Codemode and other programmatic callers keep the exact structured receipt
 * (see `projectAttemptToolResultForCaller`). Output text is never altered:
 * omitted middles, retention gaps and continuation cursors are stated in
 * words. An error, or a result that does not look like a command read, is
 * returned unchanged.
 */
export function projectCommandReadToolResultForModel(
  identity: AttemptToolIdentity,
  result: AttemptToolResultValue,
): AttemptToolResultValue {
  if (
    identity.serverId !== "opengeni" ||
    (identity.toolName !== "command_read" && identity.toolName !== "command_wait") ||
    result.isError === true ||
    result.content.length !== 1
  ) {
    return result;
  }
  const [content] = result.content;
  if (content?.type !== "text") return result;
  let value: unknown;
  try {
    value = JSON.parse(content.text);
  } catch {
    return result;
  }
  let text: string | null;
  try {
    text = commandReadText(value);
  } catch {
    return result;
  }
  if (text === null) return result;
  return { isError: false, content: [{ type: "text", text }] };
}

function commandReadText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.commands)) {
    const commands = value.commands;
    if (commands.length === 0 || !commands.every(isCommandRead)) return null;
    const lines = [
      `Waited ${seconds(value.waitedMs)} for ${value.waitFor === "any" ? "any" : "all"} of ${commands.length} commands${value.timedOut === true ? "; the wait timed out" : ""}.`,
      ...waitNotes(value),
    ];
    return [lines.join("\n"), ...commands.map((command) => commandBlock(command))].join("\n\n");
  }
  if (!isCommandRead(value)) return null;
  return [commandBlock(value, value), ...waitNotes(value)].join("\n");
}

function commandBlock(command: JsonRecord, wait?: JsonRecord): string {
  const lines = [stateLine(command, wait)];
  if (isRecord(command.failure) && typeof command.failure.code === "string") {
    const detail = isRecord(command.failure.detail)
      ? Object.entries(command.failure.detail)
          .map(([key, detailValue]) => `${key}: ${String(detailValue)}`)
          .join("; ")
      : "";
    lines.push(`Failure: ${command.failure.code}${detail ? ` (${detail})` : ""}`);
  }
  if (typeof command.notice === "string") lines.push(command.notice);
  if (isRecord(command.freshness) && command.freshness.status === "refresh_unavailable") {
    lines.push(
      "The machine could not be reached for fresh output; this is the output retained so far.",
    );
  }
  const head = chunkText(command.chunks);
  const tail = isRecord(command.tail) ? chunkText(command.tail.chunks) : "";
  const omitted = isRecord(command.omitted) ? command.omitted : null;
  if (head === "" && tail === "" && omitted === null) {
    lines.push(command.terminal === true ? "Output: (none)" : "Output: (no new output)");
  } else {
    lines.push("Output:");
    let output = head;
    if (omitted !== null) {
      if (output !== "" && !output.endsWith("\n")) output += "\n";
      output += `[... ${omittedSize(omitted.bytes)} omitted; to read them, call command_read with cursor ${String(omitted.cursor)}${command.terminal === true ? "" : " and waitSeconds 0"} ...]\n`;
      output += tail;
    }
    lines.push(output);
  }
  if (omitted === null && command.hasMore === true && typeof command.nextCursor === "string") {
    lines.push(
      `More output follows; continue with cursor ${command.nextCursor}${command.terminal === true ? "" : " and waitSeconds 0"}.`,
    );
  }
  if (command.terminal !== true) {
    const cursor = typeof command.endCursor === "string" ? command.endCursor : command.nextCursor;
    if (typeof cursor === "string" && (omitted !== null || command.hasMore !== true)) {
      lines.push(`For output after this, read with cursor ${cursor}.`);
    }
  }
  const gaps =
    isRecord(command.retention) && Array.isArray(command.retention.gaps)
      ? command.retention.gaps.filter((gap): gap is string => typeof gap === "string")
      : [];
  if (gaps.length > 0) {
    lines.push(`Some output is not retained (${gaps.join(", ")}).`);
  }
  return lines.join("\n");
}

function stateLine(command: JsonRecord, wait?: JsonRecord): string {
  const id = String(command.commandId);
  const reason =
    typeof command.settlementReason === "string" && command.settlementReason !== ""
      ? ` (${command.settlementReason})`
      : "";
  switch (command.state) {
    case "exited":
      return typeof command.exitCode === "number"
        ? `Command ${id} exited with code ${command.exitCode}${reason}.`
        : `Command ${id} exited${reason}.`;
    case "lost":
      return `Command ${id} was lost${reason}; its exit code is unknown.`;
    case "stopping":
      return `Command ${id} is stopping.`;
    default: {
      const waited =
        wait && typeof wait.waitedMs === "number" && wait.waitedMs >= 1000
          ? ` after waiting ${seconds(wait.waitedMs)}`
          : "";
      return `Command ${id} is still running${waited}.`;
    }
  }
}

function waitNotes(value: JsonRecord): string[] {
  const notes: string[] = [];
  if (value.yielded === true) notes.push("The wait ended early because a Steer is pending.");
  if (value.aborted === true) notes.push("The wait was cancelled.");
  return notes;
}

function isCommandRead(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    typeof value.state === "string" &&
    typeof value.terminal === "boolean" &&
    Array.isArray(value.chunks)
  );
}

function chunkText(chunks: unknown): string {
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => (isRecord(chunk) && typeof chunk.chunk === "string" ? chunk.chunk : ""))
    .join("");
}

function omittedSize(bytes: unknown): string {
  return typeof bytes === "number" && bytes > 0 ? `about ${bytes} bytes` : "some output";
}

function seconds(milliseconds: unknown): string {
  return typeof milliseconds === "number" ? `${Math.round(milliseconds / 1000)} s` : "0 s";
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
