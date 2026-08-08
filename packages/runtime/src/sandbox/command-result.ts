/** Provider-neutral helpers for normalizing sandbox command results. */
export function sandboxCommandExitCode(result: unknown): number | null {
  if (typeof result === "string") {
    const match = result.match(/Process exited with code (-?\d+)/);
    return match ? Number(match[1]) : null;
  }
  if (!result || typeof result !== "object") return null;
  const candidate = result as {
    exitCode?: unknown;
    exit_code?: unknown;
    code?: unknown;
    status?: unknown;
  };
  for (const value of [candidate.exitCode, candidate.exit_code, candidate.code, candidate.status]) {
    if (typeof value === "number") return value;
  }
  return null;
}

export function sandboxCommandOutput(result: unknown): string {
  if (typeof result === "string") {
    const outputIndex = result.indexOf("Output:");
    return outputIndex >= 0 ? result.slice(outputIndex + "Output:".length).trim() : result.trim();
  }
  if (!result || typeof result !== "object") return "";
  const candidate = result as { output?: unknown; stdout?: unknown; stderr?: unknown };
  return [candidate.output, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

/** Return stdout exactly once for machine parsing. */
export function sandboxCommandStdout(result: unknown): string {
  if (typeof result === "string") return sandboxCommandOutput(result);
  if (!result || typeof result !== "object") return "";
  const candidate = result as { output?: unknown; stdout?: unknown };
  if (typeof candidate.stdout === "string" && candidate.stdout.length > 0) {
    return candidate.stdout;
  }
  return typeof candidate.output === "string" ? candidate.output : "";
}

export function sandboxCommandStillRunning(result: unknown): boolean {
  if (typeof result === "string") return /Process running with session ID \d+/u.test(result);
  if (!result || typeof result !== "object") return false;
  const candidate = result as { sessionId?: unknown; session_id?: unknown };
  return typeof candidate.sessionId === "number" || typeof candidate.session_id === "number";
}
