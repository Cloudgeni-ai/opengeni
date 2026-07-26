// The SDK's execCommand/writeStdin fallback returns a formatted response with
// provider metadata followed by an `Output:` delimiter and command-controlled
// output. Terminal status is authoritative only in the metadata header; the
// output body is untrusted and may contain exact copies of SDK banner lines.

const EXEC_BANNER_HEADER_MAX_CHARS = 16 * 1024;
const OUTPUT_DELIMITER = /\r?\nOutput:\r?\n/u;
const SDK_METADATA_LINE =
  /^(?:Chunk ID:|Wall time:|Original token count:|Output:|Process (?:running with session ID|exited with code))/mu;
const RUNNING_LINE = /^Process running with session ID (\d+)$/u;
const EXITED_LINE = /^Process exited with code (-?\d+)$/u;
const PROCESS_STATUS_PREFIX = /^Process (?:running with session ID|exited with code)/u;

export type ExecResponseBanner =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "running"; sessionId: number }
  | { kind: "exited"; exitCode: number };

/** Parse exactly one terminal status from the SDK metadata header. Responses
 * that resemble SDK output but lack a complete delimiter/header are invalid,
 * while raw provider output without SDK metadata remains `absent` so callers
 * may use their provider-specific body markers. */
export function parseExecResponseBanner(raw: string): ExecResponseBanner {
  const delimiter = OUTPUT_DELIMITER.exec(raw);
  if (!delimiter) {
    return SDK_METADATA_LINE.test(raw) ? { kind: "invalid" } : { kind: "absent" };
  }
  if (delimiter.index > EXEC_BANNER_HEADER_MAX_CHARS) return { kind: "invalid" };

  const header = raw.slice(0, delimiter.index);
  const status: Array<{ kind: "running"; value: string } | { kind: "exited"; value: string }> = [];
  for (const line of header.split(/\r?\n/u)) {
    const running = RUNNING_LINE.exec(line);
    if (running) {
      status.push({ kind: "running", value: running[1]! });
      continue;
    }
    const exited = EXITED_LINE.exec(line);
    if (exited) {
      status.push({ kind: "exited", value: exited[1]! });
      continue;
    }
    // A status-looking metadata line that is malformed is ambiguous and must
    // not be normalized into another process identity or terminal result.
    if (PROCESS_STATUS_PREFIX.test(line)) return { kind: "invalid" };
  }
  if (status.length !== 1) return { kind: "invalid" };

  const terminal = status[0]!;
  const value = Number(terminal.value);
  if (!Number.isSafeInteger(value)) return { kind: "invalid" };
  if (terminal.kind === "running") {
    return value >= 0 ? { kind: "running", sessionId: value } : { kind: "invalid" };
  }
  return { kind: "exited", exitCode: value };
}

export function parseExecBannerSessionId(raw: string): number | null {
  const banner = parseExecResponseBanner(raw);
  return banner.kind === "running" ? banner.sessionId : null;
}

export function parseExecBannerExitCode(raw: string): number | null {
  const banner = parseExecResponseBanner(raw);
  return banner.kind === "exited" ? banner.exitCode : null;
}
