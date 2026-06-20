import type {
  SandboxCommandOutputDeltaPayload,
  SessionEvent,
  TerminalPtyExitedPayload,
  TerminalPtyOutputDeltaPayload,
} from "@opengeni/sdk";
import { useMemo } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type TerminalChunk = {
  /** Stable key (the source event id) so the xterm writer tracks a written-cursor. */
  id: string;
  /** Raw output bytes (utf-8 lossy) — written verbatim into xterm. */
  text: string;
  /** stdout vs stderr (drives optional tinting). */
  stream: "stdout" | "stderr";
  /** Global ordering: the source event sequence. */
  seq: number;
};

export type UseSandboxTerminalOptions = ClientOverride & {
  /** The live session event log (usually `useSessionEvents().events`). */
  events: SessionEvent[];
  /** Restrict to one PTY (by ptyId). Omit to interleave the agent firehose +
   *  every PTY. */
  ptyId?: string | undefined;
  /** Include the agent's command-output firehose (sandbox.command.output.delta).
   *  Default true — the read-only "terminal-as-events" the data path settled on. */
  includeAgentFirehose?: boolean | undefined;
};

export type UseSandboxTerminalResult = {
  /** Ordered, deduped output chunks to write() into xterm.js. */
  chunks: TerminalChunk[];
  /** Whether a PTY is currently open (drives the prompt/cursor affordance). */
  running: boolean;
  /**
   * Interactive write fn when a PTY is open and the backend supports stdin
   * (`terminal.transport === "pty-ws"` / `PtyOpenResponse.supportsInput`). Null
   * in the read-only event-projection case (v1 default).
   */
  write: ((data: string) => void) | null;
  /** The active PTY id, if one is open. */
  activePtyId: string | null;
};

/**
 * Project the Channel-A event log into an xterm-writable byte stream. The
 * terminal is "terminal-as-events": there is NO new socket in v1 — the agent's
 * command output (`sandbox.command.output.delta`) and any interactive PTY
 * (`terminal.pty.output.delta`) ride the existing SSE spine. When a PTY is open
 * and the backend accepts stdin, `write` pipes keystrokes via the SDK
 * `terminalPtyWrite` (the synchronous Channel-A control path).
 */
export function useSandboxTerminal(
  sessionId: string | null | undefined,
  options: UseSandboxTerminalOptions,
): UseSandboxTerminalResult {
  const { client, workspaceId } = useOpenGeni(options);
  const includeAgentFirehose = options.includeAgentFirehose ?? true;
  const ptyFilter = options.ptyId;

  const { chunks, openPty, supportsInput } = useMemo(() => {
    const out: TerminalChunk[] = [];
    // Track PTY lifecycle so `running`/`write` reflect the latest state.
    const open = new Map<string, { supportsInput: boolean }>();
    let lastOpened: string | null = null;
    let lastSupportsInput = false;

    for (const event of options.events) {
      if (event.type === "terminal.pty.started") {
        const payload = event.payload as { ptyId?: string } | null;
        if (payload?.ptyId) {
          open.set(payload.ptyId, { supportsInput: true });
          lastOpened = payload.ptyId;
        }
        continue;
      }
      if (event.type === "terminal.pty.exited") {
        const payload = event.payload as TerminalPtyExitedPayload | null;
        if (payload?.ptyId) {
          open.delete(payload.ptyId);
          if (lastOpened === payload.ptyId) lastOpened = null;
        }
        continue;
      }
      if (event.type === "terminal.pty.output.delta") {
        const payload = event.payload as TerminalPtyOutputDeltaPayload | null;
        if (!payload || (ptyFilter && payload.ptyId !== ptyFilter)) continue;
        out.push({
          id: event.id,
          text: payload.chunk,
          stream: payload.stream === "stderr" ? "stderr" : "stdout",
          seq: event.sequence,
        });
        continue;
      }
      if (includeAgentFirehose && !ptyFilter && event.type === "sandbox.command.output.delta") {
        const payload = event.payload as SandboxCommandOutputDeltaPayload | null;
        if (!payload?.chunk) continue;
        out.push({
          id: event.id,
          text: payload.chunk,
          stream: payload.stream === "stderr" ? "stderr" : "stdout",
          seq: event.sequence,
        });
      }
    }

    // Stable order: by sequence (the SSE spine guarantees per-session ordering).
    out.sort((a, b) => a.seq - b.seq);
    const activePty = ptyFilter && open.has(ptyFilter) ? ptyFilter : lastOpened;
    lastSupportsInput = activePty ? (open.get(activePty)?.supportsInput ?? false) : false;
    return { chunks: out, openPty: activePty, supportsInput: lastSupportsInput };
  }, [options.events, ptyFilter, includeAgentFirehose]);

  const write = useMemo(() => {
    if (!openPty || !supportsInput || !sessionId) return null;
    return (data: string) => {
      void client.terminalPtyWrite(workspaceId, sessionId, { ptyId: openPty, data }).catch(() => {});
    };
  }, [client, workspaceId, sessionId, openPty, supportsInput]);

  return {
    chunks,
    running: openPty !== null,
    write,
    activePtyId: openPty,
  };
}
