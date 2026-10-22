import { expect, test } from "bun:test";
import type { TerminalCapability } from "@opengeni/sdk";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import { registerSandboxTerminal } from "../src/lib/workbench-peers";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
import { fakeCapabilities } from "./sandbox-fixtures";

registerDom();

for (const reason of ["lease_cold", "not_provisioned"] as const) {
  test(`actual terminal preserves first input across ${reason} SSE acquisition until READY`, async () => {
    const original = globalThis.WebSocket;
    let input = (_value: string) => {};
    let socket!: Socket;
    let mounts = 0;
    class Socket {
      static OPEN = 1;
      readyState = 0;
      binaryType = "";
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        socket = this;
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    class Terminal {
      cols = 80;
      rows = 24;
      constructor(public options: Record<string, unknown>) {
        mounts++;
      }
      open() {}
      dispose() {}
      focus() {}
      clear() {}
      write() {}
      loadAddon() {}
      onData(callback: (data: string) => void) {
        input = callback;
        return { dispose() {} };
      }
      onResize() {
        return { dispose() {} };
      }
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const cold: TerminalCapability = {
      ...fakeCapabilities().Terminal,
      transport: "sse-events",
      ptyCapable: true,
      reason,
    };
    const render = (capability: TerminalCapability) => (
      <SandboxTerminal
        result={{
          chunks: [],
          running: false,
          write: null,
          activePtyId: null,
          close() {},
          error: null,
        }}
        terminalCapability={capability}
      />
    );
    const view = await renderComponent(render(cold));
    try {
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
      await actRun(() => input("echo EARLY_ONCE\r"));
      await view.rerender(
        render({
          ...cold,
          transport: "pty-ws",
          reason: null,
          url: "https://terminal.example",
          token: "synthetic",
        }),
      );
      await flush();
      const nonce = "a".repeat(32);
      await actRun(() => {
        socket.readyState = 1;
        socket.onopen?.();
        socket.onmessage?.({ data: '2{"opengeniInputReady":"bash-readline-v1"}' });
        socket.onmessage?.({ data: `0\x1b]777;opengeni-input;hello;${nonce}\x07banner\r\n` });
      });
      expect(socket.sent.filter((value) => value.startsWith("0"))).toEqual([]);
      await actRun(() =>
        socket.onmessage?.({ data: `0\x1b]777;opengeni-input;ready;${nonce}\x07` }),
      );
      expect(socket.sent.filter((value) => value.startsWith("0"))).toEqual(["0echo EARLY_ONCE\r"]);
      await actRun(() =>
        socket.onmessage?.({ data: `0\x1b]777;opengeni-input;ready;${nonce}\x07` }),
      );
      expect(socket.sent.filter((value) => value.startsWith("0"))).toHaveLength(1);
      expect(mounts).toBe(1);
    } finally {
      await view.unmount();
      registerSandboxTerminal(null);
      globalThis.WebSocket = original;
    }
  });
}
