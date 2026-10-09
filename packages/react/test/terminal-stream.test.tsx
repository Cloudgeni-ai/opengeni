import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
import { actRun, flush, registerDom, renderHook } from "./render-hook";
import {
  MAX_PENDING_TERMINAL_INPUT_CODE_UNITS,
  useTerminalStream,
} from "../src/hooks/use-terminal-stream";
import { TERMINAL_INPUT_READY_PROTOCOL } from "../src/lib/terminal-input-readiness";

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
  failNextInput = false;
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
    if (this.failNextInput && typeof data === "string" && data.startsWith("0")) {
      this.failNextInput = false;
      throw new Error("input was not queued");
    }
    this.sent.push(data);
  }

  open(preferences: Record<string, unknown> | false = {}) {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    if (this.protocols === "tty" && preferences !== false) {
      this.onmessage?.({ data: "2" + JSON.stringify(preferences) });
    }
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
const relayCapability = (url: string) => ({
  transport: "relay-pty" as const,
  url,
  token: "relay-scoped",
  expiresAt: null,
});

function relayDatagram(tag: number, body: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = tag;
  bytes.set(body, 1);
  return bytes.buffer;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("useTerminalStream connection boundary", () => {
  test("keeps command callbacks stable while connection status changes", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/stable") }),
      undefined,
    );
    await flush();
    const before = hook.result.current;
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open());
    await flush();
    expect(hook.result.current.status).toBe("open");
    expect(hook.result.current.write).toBe(before.write);
    expect(hook.result.current.resize).toBe(before.resize);
    expect(hook.result.current.disconnect).toBe(before.disconnect);
    await hook.unmount();
  });

  test("preserves explicitly legacy input after old ttyd preferences", async () => {
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
    expect(hook.result.current.inputReadiness).toBe("legacy");
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
    expect(socket.sent).toHaveLength(2);
    await actRun(() => socket.onmessage?.({ data: "2{}" }));
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

  test("reconnects the same transport before requesting a fresh grant", async () => {
    let reconnects = 0;
    const hook = await renderHook(
      () =>
        useTerminalStream({
          capability: capability("https://terminal.example/reconnect"),
          onReconnectNeeded: () => {
            reconnects += 1;
          },
        }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open());
    await actRun(() => {
      socket.onerror?.();
    });
    await actRun(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125));
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.url).toBe(socket.url);
    expect(reconnects).toBe(0);
    await hook.unmount();
  });

  test("requests one fresh grant when the relay rejects the credential", async () => {
    let reconnects = 0;
    const url = "wss://relay.example/stream?ws=ws&agent=ag&port=7681&channel=pty-1";
    const hook = await renderHook(
      () =>
        useTerminalStream({
          capability: relayCapability(url),
          onReconnectNeeded: () => {
            reconnects += 1;
          },
        }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open());
    await actRun(() =>
      socket.onmessage?.({
        data: relayDatagram(
          2,
          StreamOpenAck.encode({
            accepted: false,
            error: undefined,
            resumeFromSeq: "0",
          }).finish(),
        ),
      }),
    );
    await flush();
    expect(reconnects).toBe(1);
    await hook.unmount();
  });

  test("does not request a fresh grant for an intentional disconnect", async () => {
    let reconnects = 0;
    const hook = await renderHook(
      () =>
        useTerminalStream({
          capability: capability("https://terminal.example/intentional-close"),
          onReconnectNeeded: () => {
            reconnects += 1;
          },
        }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open());
    await actRun(() => hook.result.current.disconnect());
    await flush();
    expect(reconnects).toBe(0);
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

  test("relay PTY preserves directional cursors across credential rotation", async () => {
    const output: string[] = [];
    const oldUrl = "wss://relay.example/stream?ws=ws&agent=ag&port=7681&channel=pty-1&grant=old";
    const freshUrl =
      "wss://relay.example/stream?ws=ws&agent=ag&port=7681&channel=pty-1&grant=fresh";
    const hook = await renderHook(
      (props: { url: string }) =>
        useTerminalStream({
          capability: relayCapability(props.url),
          onOutput: (chunk) => output.push(chunk),
        }),
      { url: oldUrl },
    );
    await flush();
    const old = FakeWebSocket.instances[0]!;
    await actRun(() => old.open());
    const firstOpen = new Uint8Array(old.sent[0] as unknown as ArrayBuffer);
    expect(StreamOpen.decode(firstOpen.subarray(1)).resumeFromSeq).toBe("0");
    await actRun(() =>
      old.onmessage?.({
        data: relayDatagram(
          2,
          StreamOpenAck.encode({ accepted: true, error: undefined, resumeFromSeq: "0" }).finish(),
        ),
      }),
    );
    await actRun(() =>
      old.onmessage?.({
        data: relayDatagram(
          3,
          StreamFrame.encode({
            channelId: "pty-1",
            seq: "0",
            data: new TextEncoder().encode("first"),
            producedAtMs: "0",
          }).finish(),
        ),
      }),
    );
    await actRun(() => hook.result.current.write("input-one"));
    const firstInput = new Uint8Array(old.sent.at(-1) as unknown as ArrayBuffer);
    expect(StreamFrame.decode(firstInput.subarray(1)).seq).toBe("0");

    await hook.rerender({ url: freshUrl });
    await flush();
    const fresh = FakeWebSocket.instances[1]!;
    await actRun(() => fresh.open());
    const resumedOpen = new Uint8Array(fresh.sent[0] as unknown as ArrayBuffer);
    expect(StreamOpen.decode(resumedOpen.subarray(1)).resumeFromSeq).toBe("1");
    await actRun(() =>
      fresh.onmessage?.({
        data: relayDatagram(
          2,
          StreamOpenAck.encode({ accepted: true, error: undefined, resumeFromSeq: "1" }).finish(),
        ),
      }),
    );
    // An overlapping replay must not print twice; the next unseen frame must.
    for (const [seq, data] of [
      ["0", "duplicate"],
      ["1", "second"],
    ] as const) {
      await actRun(() =>
        fresh.onmessage?.({
          data: relayDatagram(
            3,
            StreamFrame.encode({
              channelId: "pty-1",
              seq,
              data: new TextEncoder().encode(data),
              producedAtMs: "0",
            }).finish(),
          ),
        }),
      );
    }
    expect(output).toEqual(["first", "second"]);
    await actRun(() => hook.result.current.write("input-two"));
    const secondInput = new Uint8Array(fresh.sent.at(-1) as unknown as ArrayBuffer);
    expect(StreamFrame.decode(secondInput.subarray(1)).seq).toBe("1");
    await hook.unmount();
  });
});

const readyPreferences = { opengeniInputReady: TERMINAL_INPUT_READY_PROTOCOL };
const TERMINAL_INPUT_READY_MARKER =
  "\x1b]777;opengeni-input;hello;0123456789abcdef0123456789abcdef\x07" +
  "\x1b]777;opengeni-input;ready;0123456789abcdef0123456789abcdef\x07";
const inputFrames = (socket: FakeWebSocket) => socket.sent.filter((data) => data.startsWith("0"));

describe("negotiated ttyd input readiness", () => {
  test("intentional disconnect cancels a previously scheduled reconnect", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example") }),
      undefined,
    );
    try {
      const socket = FakeWebSocket.instances.at(-1)!;
      await actRun(() => {
        socket.open(readyPreferences);
        socket.close();
      });
      const count = FakeWebSocket.instances.length;
      await actRun(() => hook.result.current.disconnect());
      await flush(125);
      expect(FakeWebSocket.instances.length).toBe(count);
      expect(hook.result.current.status).toBe("closed");
    } finally {
      await hook.unmount();
    }
  });

  test("a synchronous live-input send failure retains only unsent input until fresh readiness", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example") }),
      undefined,
    );
    try {
      const socket = FakeWebSocket.instances.at(-1)!;
      await actRun(() => {
        socket.open(readyPreferences);
        socket.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER });
        hook.result.current.write("already-sent\r");
        socket.failNextInput = true;
        hook.result.current.write("not-sent\r");
      });
      await flush(125);
      const fresh = FakeWebSocket.instances.at(-1)!;
      await actRun(() => fresh.open(readyPreferences));
      expect(fresh.sent.filter((value) => value.startsWith("0"))).toEqual([]);
      await actRun(() => fresh.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
      expect(fresh.sent.filter((value) => value.startsWith("0"))).toEqual(["0not-sent\r"]);
    } finally {
      await hook.unmount();
    }
  });
  test("buffers before and after open; banners/control frames do not flush; split READY flushes once", async () => {
    const output: string[] = [];
    const hook = await renderHook(
      () =>
        useTerminalStream({
          capability: capability("https://terminal.example/ready"),
          onOutput: (data) => output.push(data),
        }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => hook.result.current.write("echo "));
    await actRun(() => socket.open(readyPreferences));
    await actRun(() => hook.result.current.write("SYNTHETIC\r"));
    for (const data of ["1bash", "0Starting...\r\n", "0", "2{}"]) {
      await actRun(() => socket.onmessage?.({ data }));
    }
    expect(inputFrames(socket)).toEqual([]);
    expect(hook.result.current.inputReadiness).toBe("waiting");
    expect(hook.result.current.connected).toBe(false);
    await actRun(() => hook.result.current.resize(101, 31));
    for (const part of [
      TERMINAL_INPUT_READY_MARKER.slice(0, 7),
      TERMINAL_INPUT_READY_MARKER.slice(7),
    ]) {
      await actRun(() => socket.onmessage?.({ data: new TextEncoder().encode("0" + part).buffer }));
    }
    expect(socket.sent.at(-2)).toBe('1{"columns":101,"rows":31}');
    expect(inputFrames(socket)).toEqual(["0echo SYNTHETIC\r"]);
    expect(hook.result.current.inputReadiness).toBe("ready");
    expect(hook.result.current.connected).toBe(true);
    await actRun(() => socket.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    await actRun(() => hook.result.current.write("next\r"));
    expect(inputFrames(socket)).toEqual(["0echo SYNTHETIC\r", "0next\r"]);
    expect(output.join("")).toBe("Starting...\r\n");
    await hook.unmount();
  });

  test("silent shells need no visible prompt once explicit READY arrives", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/silent") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open(readyPreferences));
    await actRun(() => hook.result.current.write("echo silent\r"));
    expect(inputFrames(socket)).toEqual([]);
    await actRun(() => socket.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    expect(inputFrames(socket)).toEqual(["0echo silent\r"]);
    await hook.unmount();
  });

  test("manual startup input explicitly discards buffered typing and never replays it on late READY", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/startup-read") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open(readyPreferences));
    await actRun(() => hook.result.current.write("must-not-be-password\r"));
    await actRun(() => hook.result.current.useLegacyInput());
    expect(hook.result.current.inputReadiness).toBe("legacy");
    expect(inputFrames(socket)).toEqual([]);
    await actRun(() => hook.result.current.write("deliberate-startup-answer\r"));
    await actRun(() => socket.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    expect(inputFrames(socket)).toEqual(["0deliberate-startup-answer\r"]);
    expect(hook.result.current.inputReadiness).toBe("legacy");
    await hook.unmount();
  });

  test("unknown and malformed negotiation require deliberate manual escape", async () => {
    for (const preferences of ['{"opengeniInputReady":"future-v9"}', "null", "broken"]) {
      const hook = await renderHook(
        () => useTerminalStream({ capability: capability("https://terminal.example/unknown") }),
        undefined,
      );
      await flush();
      const socket = FakeWebSocket.instances.at(-1)!;
      await actRun(() => socket.open(false));
      await actRun(() => hook.result.current.write("pending\r"));
      await actRun(() => socket.onmessage?.({ data: "2" + preferences }));
      await actRun(() => socket.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
      expect(hook.result.current.inputReadiness).toBe("waiting");
      expect(inputFrames(socket)).toEqual([]);
      await actRun(() => hook.result.current.useLegacyInput());
      expect(hook.result.current.inputReadiness).toBe("legacy");
      expect(inputFrames(socket)).toEqual([]);
      await hook.unmount();
    }
  });

  test("failed queue send reconnects, waits for new READY and sends unsent input only once", async () => {
    const hook = await renderHook(
      () => useTerminalStream({ capability: capability("https://terminal.example/retry-ready") }),
      undefined,
    );
    await flush();
    const old = FakeWebSocket.instances[0]!;
    await actRun(() => old.open(readyPreferences));
    await actRun(() => hook.result.current.write("unsent\r"));
    old.failNextInput = true;
    await actRun(() => old.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    expect(inputFrames(old)).toEqual([]);
    await actRun(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125));
    });
    const fresh = FakeWebSocket.instances[1]!;
    await actRun(() => fresh.open(readyPreferences));
    expect(inputFrames(fresh)).toEqual([]);
    await actRun(() => fresh.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    expect(inputFrames(fresh)).toEqual(["0unsent\r"]);
    await hook.unmount();
  });

  test("rotation fences old READY and does not reuse readiness or replay dispatched commands", async () => {
    const hook = await renderHook(
      (props: { url: string }) => useTerminalStream({ capability: capability(props.url) }),
      { url: "https://terminal.example/old-ready" },
    );
    await flush();
    const old = FakeWebSocket.instances[0]!;
    await actRun(() => old.open(readyPreferences));
    await actRun(() => hook.result.current.write("once\r"));
    await actRun(() => old.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    const staleMessage = old.onmessage;
    const staleClose = old.onclose;
    await hook.rerender({ url: "https://terminal.example/new-ready" });
    await flush();
    const fresh = FakeWebSocket.instances[1]!;
    await actRun(() => fresh.open(readyPreferences));
    await actRun(() => hook.result.current.write("new\r"));
    await actRun(() => {
      staleMessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER });
      staleClose?.();
    });
    expect(inputFrames(fresh)).toEqual([]);
    expect(hook.result.current.inputReadiness).toBe("waiting");
    await actRun(() => fresh.onmessage?.({ data: "0" + TERMINAL_INPUT_READY_MARKER }));
    expect(inputFrames(old)).toEqual(["0once\r"]);
    expect(inputFrames(fresh)).toEqual(["0new\r"]);
    await hook.unmount();
  });

  test("overflow while waiting rejects the whole command, including late READY/manual escape", async () => {
    const hook = await renderHook(
      () =>
        useTerminalStream({ capability: capability("https://terminal.example/ready-overflow") }),
      undefined,
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    await actRun(() => socket.open(readyPreferences));
    const lateReady = socket.onmessage;
    await actRun(() =>
      hook.result.current.write("x".repeat(MAX_PENDING_TERMINAL_INPUT_CODE_UNITS + 1)),
    );
    await actRun(() => {
      lateReady?.({ data: "0" + TERMINAL_INPUT_READY_MARKER });
      hook.result.current.useLegacyInput();
    });
    expect(hook.result.current.status).toBe("error");
    expect(inputFrames(socket)).toEqual([]);
    await hook.unmount();
  });
});
