import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ProviderCommandOutput } from "../src/sandbox/provider-command-session";
import type { SynchronousCommandPage } from "../src/sandbox/synchronous-command";

/** Explicit trusted pages for protocol unit tests. Banner text is deliberately
 * not parsed: fixtures must supply the actual separate streams and exit. */
export function synchronousOutputFixture() {
  const pages = new Map<unknown, ProviderCommandOutput>();
  let command: ModalRouterProviderCommand;
  const reset = () => {
    command = {
      kind: "modal-router-v1",
      sandboxId: "sb-fixture",
      taskId: "task-fixture",
      execId: crypto.randomUUID(),
      streams: {
        stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      },
    };
  };
  reset();
  return {
    reset,
    getProviderCommandOutput: (raw: unknown) => pages.get(raw) ?? null,
    record<T>(raw: T, stdout: string, stderr = "", exitCode: number | null = null): T {
      const expected = structuredClone(command);
      const chunks: ProviderCommandOutput["chunks"] = [];
      for (const stream of ["stdout", "stderr"] as const) {
        const text = stream === "stdout" ? stdout : stderr;
        command.streams[stream].byteOffset += Buffer.byteLength(text);
        command.streams[stream].eof = exitCode !== null;
        command.streams[stream].exitCode = exitCode;
        if (text) chunks.push({ stream, text, chunkId: crypto.randomUUID() });
      }
      pages.set(raw, { command: structuredClone(command), expected, chunks, exitCode });
      return raw;
    },
  };
}

/** Protocol fixture for the native collector's separate-page contract. This
 * is not a provider adapter: callers supply streams, status and locator instead
 * of treating the presentation banner as stream or completion evidence. */
export function synchronousNativeOutputFixture() {
  const pages = new Map<unknown, SynchronousCommandPage>();
  const identity = crypto.randomUUID();
  const cursor = { stdout: 0, stderr: 0 };
  return {
    getSynchronousCommandOutput: (raw: unknown) => pages.get(raw) ?? null,
    record<T>(
      raw: T,
      stdout: string,
      stderr: string,
      exitCode: number | null,
      sessionId?: number,
    ): T {
      const expected = { ...cursor };
      cursor.stdout += Buffer.byteLength(stdout);
      cursor.stderr += Buffer.byteLength(stderr);
      pages.set(raw, {
        stdout,
        stderr,
        exitCode,
        wallTimeSeconds: 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
        outputCursor: { identity, expected, next: { ...cursor } },
      });
      return raw;
    },
  };
}
