import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { actRun, flush, registerDom, renderHook } from "./render-hook";
import {
  MAX_PENDING_TERMINAL_INPUT_CODE_UNITS,
  useTerminalStream,
} from "../src/hooks/use-terminal-stream";

registerDom();

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const originalWebSocket = globalThis.WebSocket;
const capability = (url: string | null) => ({
  transport: "pty-ws" as const,
  url,
  token: "scoped",
  expiresAt: null,
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("useTerminalStream connection boundary", () => {
  test("buffers pre-open input and flushes it only after ttyd auth and resize", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/one") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    expect(hook.result.current.status).toBe("connecting");

    await actRun(() => {
      hook.result.current.write("printf '");
      hook.result.current.write("ready\\n'");
    });
    expect(socket.sent).toEqual([]);

    await actRun(() => socket.open());
    await flush();
    expect(hook.result.current.status).toBe("open");
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[0]).toContain("AuthToken");
    expect(socket.sent[1]?.startsWith("1")).toBe(true);
    expect(socket.sent[2]).toBe("0printf 'ready\\n'");
    await hook.unmount();
  });

  test("does not treat websocket OPEN as ttyd-authenticated", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/auth-race") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    await actRun(() => hook.result.current.write("queued-before-auth\n"));
    expect(socket.sent).toEqual([]);

    await actRun(() => socket.onopen?.());
    await flush();
    expect(socket.sent[0]).toContain("AuthToken");
    expect(socket.sent[1]?.startsWith("1")).toBe(true);
    expect(socket.sent[2]).toBe("0queued-before-auth\n");
    await hook.unmount();
  });

  test("preserves first input while an exact terminal grant is still being minted", async () => {
    const initial: { url: string | null } = { url: null };
    const hook = await renderHook(
      (props: { url: string | null }) => useTerminalStream({ capability: capability(props.url) }),
      initial,
    );
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await actRun(() => hook.result.current.write("echo preserved\\n"));

    await hook.rerender({ url: "https://terminal.example/fresh" });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const fresh = FakeWebSocket.instances[0]!;
    await actRun(() => fresh.open());
    await flush();
    expect(fresh.sent.at(-1)).toBe("0echo preserved\\n");
    await hook.unmount();
  });

  test("rejects a stale rolling credential and replays input only to its fresh replacement", async () => {
    type Props = { url: string; expiresAt: string };
    const hook = await renderHook(
      (props: Props) =>
        useTerminalStream({ capability: { ...capability(props.url), expiresAt: props.expiresAt } }),
      { url: "https://terminal.example/stale", expiresAt: "2000-01-01T00:00:00.000Z" },
    );
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await actRun(() => hook.result.current.write("fresh-only\n"));

    await hook.rerender({
      url: "https://terminal.example/fresh-after-stale",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await flush();
    const fresh = FakeWebSocket.instances[0]!;
    await actRun(() => fresh.open());
    await flush();
    expect(fresh.sent.at(-1)).toBe("0fresh-only\n");
    await hook.unmount();
  });

  test("preserves input across a clean socket close and credential rotation", async () => {
    const hook = await renderHook(
      (props: { url: string }) => useTerminalStream({ capability: capability(props.url) }),
      { url: "https://terminal.example/old" },
    );
    await flush();
    const old = FakeWebSocket.instances[0]!;
    await actRun(() => old.open());
    await actRun(() => old.close());
    await flush();
    await actRun(() => hook.result.current.write("echo after-rotation\n"));

    await hook.rerender({ url: "https://terminal.example/new" });
    await flush();
    const fresh = FakeWebSocket.instances[1]!;
    await actRun(() => fresh.open());
    await flush();
    expect(fresh.sent.at(-1)).toBe("0echo after-rotation\n");
    await hook.unmount();
  });

  test("drops queued PTY input across a transport downgrade", async () => {
    type Props = { transport: "pty-ws" | "sse-events"; url: string | null };
    const initial: Props = { transport: "pty-ws", url: null };
    const hook = await renderHook(
      (props: Props) =>
        useTerminalStream({
          capability: {
            transport: props.transport,
            url: props.url,
            token: null,
            expiresAt: null,
          },
        }),
      initial,
    );
    await flush();
    await actRun(() => hook.result.current.write("must-not-replay\n"));
    await hook.rerender({ transport: "sse-events", url: null });
    await flush();
    await hook.rerender({ transport: "pty-ws", url: "https://terminal.example/reacquired" });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open());
    await flush();
    expect(socket.sent).toHaveLength(2);
    await hook.unmount();
  });

  test("fails the connection without sending a truncated command on queue overflow", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/overflow") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;

    await actRun(() =>
      hook.result.current.write("x".repeat(MAX_PENDING_TERMINAL_INPUT_CODE_UNITS + 1)),
    );
    await flush();
    expect(hook.result.current.status).toBe("error");
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.sent).toEqual([]);
    await hook.unmount();
  });
});
