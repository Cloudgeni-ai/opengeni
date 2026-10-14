import { afterEach, expect, test } from "bun:test";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import { registerSandboxTerminal } from "../src/lib/workbench-peers";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
import { fakeCapabilities } from "./sandbox-fixtures";

registerDom();
const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  registerSandboxTerminal(null);
});

test("production component exposes an explicit queue-discarding manual escape, including without a header", async () => {
  for (const showHeader of [true, false]) {
    let input: (value: string) => void = () => {};
    let focus = 0;
    let socket!: Socket;
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
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    class Terminal {
      cols = 80;
      rows = 24;
      constructor(public options: Record<string, unknown>) {}
      open() {}
      dispose() {}
      focus() {
        focus++;
      }
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
    const view = await renderComponent(
      <SandboxTerminal
        result={{
          chunks: [],
          running: false,
          write: null,
          activePtyId: null,
          close() {},
          error: null,
        }}
        terminalCapability={{
          ...fakeCapabilities().Terminal,
          transport: "pty-ws",
          ptyCapable: true,
          url: "https://terminal.example",
          token: "synthetic",
        }}
        showHeader={showHeader}
      />,
    );
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
      await actRun(() => {
        socket.readyState = 1;
        socket.onopen?.();
        socket.onmessage?.({ data: '2{"opengeniInputReady":"bash-readline-v1"}' });
        input("must-not-execute\r");
      });
      expect(view.container.textContent).toContain("Waiting for shell readiness");
      expect(socket.sent.filter((value) => value.startsWith("0"))).toEqual([]);
      const button = [...view.container.querySelectorAll("button")].find(
        (item) => item.textContent === "Use manual input",
      )!;
      expect(button.title).toContain("Early input is not guaranteed");
      await actRun(() => button.click());
      expect(view.container.textContent?.toLowerCase()).toContain("legacy input");
      expect(view.container.textContent).not.toContain("Use manual input");
      expect(focus).toBeGreaterThan(0);
      await actRun(() => input("manual-answer\r"));
      expect(socket.sent.filter((value) => value.startsWith("0"))).toEqual(["0manual-answer\r"]);
    } finally {
      await view.unmount();
      registerSandboxTerminal(null);
    }
  }
});
