import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventListOptions, SessionEventPage } from "@opengeni/sdk";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import {
  SANDBOX_TERMINAL_HISTORY_ROWS,
  useSandboxTerminal,
  type TerminalChunk,
  type UseSandboxTerminalResult,
} from "../src/hooks/use-sandbox-terminal";
import { registerSandboxTerminal } from "../src/lib/workbench-peers";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();
afterEach(() => registerSandboxTerminal(null));

function row(
  sequence: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId: string | null = null,
): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_750_000_000_000 + sequence * 1000).toISOString(),
    clientEventId: null,
    turnId,
  };
}

const pty = (sequence: number, chunk: string) =>
  row(sequence, "terminal.pty.output.delta", { ptyId: "p1", stream: "stdout", chunk, seq: 0 });
const command = (sequence: number, chunk: string, turnId: string) =>
  row(sequence, "sandbox.command.output.delta", { stream: "stdout", chunk }, turnId);

/**
 * A reloaded session: two finished turns with command output, and an
 * interactive PTY between them. Conversation reads carry none of the output.
 */
function reloadedSession() {
  const store: SessionEvent[] = [
    row(1, "user.message", { text: "run the tests" }),
    row(2, "turn.started", {}, "T1"),
    command(3, "bun test\r\n", "T1"),
    command(4, "412 pass\r\n", "T1"),
    row(5, "turn.completed", {}, "T1"),
    row(6, "terminal.pty.started", { ptyId: "p1" }),
    pty(7, "$ git status\r\n"),
    pty(8, "nothing to commit\r\n"),
    row(9, "user.message", { text: "deploy" }),
    row(10, "turn.started", {}, "T2"),
    command(11, "deployed api\r\n", "T2"),
    row(12, "turn.completed", {}, "T2"),
  ];
  const output = new Set(["terminal.pty.output.delta", "sandbox.command.output.delta"]);
  const conversation = store.filter((event) => !output.has(event.type));
  const reads: SessionEventListOptions[] = [];
  const listEventPage = async (
    _workspaceId: string,
    _sessionId: string,
    options: SessionEventListOptions = {},
  ): Promise<SessionEventPage> => {
    reads.push(options);
    const include = new Set<string>(options.includeTypes ?? []);
    const rows = store.filter((event) => include.has(event.type));
    const page = rows.slice(-(options.limit ?? 500));
    return {
      events: page,
      mode: "forensic",
      payloadMode: "full",
      direction: "before",
      bytes: 2,
      maxBytes: 1024 * 1024,
      truncated: false,
      hasMore: rows.length > page.length,
      truncatedBy: null,
      coveredSequence: null,
      nextAfter: null,
      nextBefore: null,
      forensicExact: true,
    };
  };
  return { store, conversation, reads, listEventPage };
}

describe("sandbox terminal history", () => {
  test("after a reload the terminal reads PTY scrollback and past command output on demand", async () => {
    const session = reloadedSession();
    const client = Object.assign(fakeClient({}), { listEventPage: session.listEventPage });
    const hook = await renderHook(
      (props: { history: boolean; events: SessionEvent[] }) =>
        useSandboxTerminal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: props.events,
          history: props.history,
        }),
      { history: false, events: session.conversation },
    );
    try {
      await flush();
      // A closed terminal reads nothing.
      expect(session.reads).toHaveLength(0);
      expect(hook.result.current.chunks).toEqual([]);

      await hook.rerender({ history: true, events: session.conversation });
      await flush();
      expect(session.reads).toEqual([
        {
          includeTypes: ["terminal.pty.output.delta", "sandbox.command.output.delta"],
          direction: "before",
          mode: "forensic",
          payloadMode: "full",
          limit: SANDBOX_TERMINAL_HISTORY_ROWS,
        },
      ]);
      expect(hook.result.current.chunks.map((chunk) => chunk.text)).toEqual([
        "bun test\r\n",
        "412 pass\r\n",
        "$ git status\r\n",
        "nothing to commit\r\n",
        "deployed api\r\n",
      ]);

      // Live output keeps streaming in, once each, and stays after the host's
      // event window lets it go.
      const live = [...session.conversation, pty(13, "$ ls\r\n"), pty(8, "nothing to commit\r\n")];
      await hook.rerender({ history: true, events: live });
      await hook.rerender({ history: true, events: session.conversation });
      await flush();
      expect(hook.result.current.chunks.map((chunk) => chunk.seq)).toEqual([3, 4, 7, 8, 11, 13]);
      // The history was read once.
      expect(session.reads).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  test("a PTY-only terminal reads only PTY output", async () => {
    const session = reloadedSession();
    const client = Object.assign(fakeClient({}), { listEventPage: session.listEventPage });
    const hook = await renderHook(
      () =>
        useSandboxTerminal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: session.conversation,
          includeAgentFirehose: false,
        }),
      undefined,
    );
    try {
      await flush();
      expect(session.reads.map((read) => read.includeTypes)).toEqual([
        ["terminal.pty.output.delta"],
      ]);
      expect(hook.result.current.chunks.map((chunk) => chunk.seq)).toEqual([7, 8]);
    } finally {
      await hook.unmount();
    }
  });

  test("a failed history read is asked again when the terminal reopens", async () => {
    const session = reloadedSession();
    let fail = true;
    const client = Object.assign(fakeClient({}), {
      listEventPage: async (
        workspaceId: string,
        sessionId: string,
        options?: SessionEventListOptions,
      ) => {
        if (fail) {
          fail = false;
          throw new Error("unavailable");
        }
        return await session.listEventPage(workspaceId, sessionId, options);
      },
    });
    const hook = await renderHook(
      (props: { history: boolean }) =>
        useSandboxTerminal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: session.conversation,
          history: props.history,
        }),
      { history: true },
    );
    try {
      await flush();
      expect(hook.result.current.chunks).toEqual([]);
      await hook.rerender({ history: false });
      await hook.rerender({ history: true });
      await flush();
      expect(hook.result.current.chunks).toHaveLength(5);
    } finally {
      await hook.unmount();
    }
  });
});

describe("SandboxTerminal transcript order", () => {
  function terminalResult(chunks: TerminalChunk[]): UseSandboxTerminalResult {
    return { chunks, running: false, write: null, activePtyId: null, close() {}, error: null };
  }
  const chunk = (seq: number): TerminalChunk => ({
    id: `c-${seq}`,
    text: `line ${seq}\r\n`,
    stream: "stdout",
    seq,
  });

  async function mountTerminal(chunks: TerminalChunk[]) {
    const log: string[] = [];
    class Terminal {
      cols = 80;
      rows = 24;
      constructor(public options: Record<string, unknown>) {}
      open() {}
      dispose() {}
      focus() {}
      clear() {
        log.push("clear");
      }
      reset() {
        log.push("reset");
      }
      write(data: string) {
        log.push(data);
      }
      loadAddon() {}
      onData() {
        return { dispose() {} };
      }
      onResize() {
        return { dispose() {} };
      }
    }
    const view = await renderComponent(
      <SandboxTerminal result={terminalResult(chunks)} showHeader />,
    );
    const container = view.container.querySelector<HTMLElement>("[data-opengeni-terminal]")!;
    Object.defineProperties(container, {
      clientWidth: { value: 320 },
      clientHeight: { value: 180 },
    });
    await actRun(() =>
      registerSandboxTerminal(async () => ({
        Terminal,
        FitAddon: class {
          fit() {}
        },
        WebLinksAddon: class {
          dispose() {}
        },
      })),
    );
    await flush(30);
    return { view, log };
  }

  test("history that lands after live output is written again in order", async () => {
    const { view, log } = await mountTerminal([chunk(10)]);
    try {
      expect(log).toEqual(["line 10\r\n"]);
      log.length = 0;
      await view.rerender(
        <SandboxTerminal result={terminalResult([chunk(3), chunk(5), chunk(10)])} showHeader />,
      );
      expect(log).toEqual(["reset", "line 3\r\n", "line 5\r\n", "line 10\r\n"]);
      log.length = 0;
      // Newer output appends without a rewrite.
      await view.rerender(
        <SandboxTerminal
          result={terminalResult([chunk(3), chunk(5), chunk(10), chunk(11)])}
          showHeader
        />,
      );
      expect(log).toEqual(["line 11\r\n"]);
    } finally {
      await view.unmount();
    }
  });

  test("cleared output is never written again", async () => {
    const { view, log } = await mountTerminal([chunk(3), chunk(5)]);
    try {
      const clear = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Clear",
      )!;
      await actRun(() => clear.click());
      log.length = 0;
      await view.rerender(
        <SandboxTerminal result={terminalResult([chunk(3), chunk(5), chunk(8)])} showHeader />,
      );
      expect(log).toEqual(["line 8\r\n"]);
      log.length = 0;
      // Older history landing later rewrites only what was not cleared.
      await view.rerender(
        <SandboxTerminal
          result={terminalResult([chunk(1), chunk(3), chunk(5), chunk(8), chunk(9)])}
          showHeader
        />,
      );
      expect(log).toEqual(["line 9\r\n"]);
    } finally {
      await view.unmount();
    }
  });
});
