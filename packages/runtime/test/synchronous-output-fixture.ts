import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ProviderCommandOutput } from "../src/sandbox/provider-command-session";

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
