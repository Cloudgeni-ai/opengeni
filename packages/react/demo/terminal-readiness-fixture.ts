/** Synthetic transport only. The demo mounts the production SandboxTerminal,
 * useTerminalStream, xterm peers and CSS; readiness advances explicitly. */
export function installTerminalReadinessFixture(mode: "ready" | "silent" | "manual" | "legacy") {
  const NativeWebSocket = globalThis.WebSocket;
  const id = "0123456789abcdef0123456789abcdef";
  const control = (event: string) => `\x1b]777;opengeni-input;${event};${id}\x07`;
  const executions: string[] = [];
  let socket: FixtureSocket | null = null;
  let ready = false;
  class FixtureSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    output(value: string) {
      this.onmessage?.({ data: "0" + value });
    }
    send(value: string) {
      if (value.startsWith("{"))
        queueMicrotask(() => {
          this.onmessage?.({
            data: mode === "legacy" ? "2{}" : '2{"opengeniInputReady":"bash-readline-v1"}',
          });
          if (mode !== "legacy") this.output(control("hello"));
          if (mode === "manual") this.output("Configuration value: ");
          else if (mode === "legacy") this.output("Legacy image — wait for the prompt.\r\n$ ");
          else if (mode !== "silent") this.output("Loading shell configuration…\r\n");
        });
      if (value.startsWith("0")) {
        executions.push(value.slice(1));
        // Async output, like a real WebSocket; avoid synchronous re-entry into
        // the production hook's send/flush path.
        queueMicrotask(() =>
          this.output(
            value.slice(1).replaceAll("\r", "\r\n") +
              (ready ? "EXECUTED ONCE\r\n$ " : "manual input received\r\n"),
          ),
        );
      }
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  globalThis.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      if (
        String(args[0]).startsWith("https://terminal.example") ||
        String(args[0]).startsWith("wss://terminal.example")
      )
        return new FixtureSocket();
      return Reflect.construct(target, args);
    },
  });
  const fixture = {
    executions,
    ready() {
      ready = true;
      socket?.output((mode === "silent" ? "" : "$ ") + control("ready"));
    },
  };
  (globalThis as Record<string, unknown>).__ogTerminalReadiness = fixture;
  return fixture;
}
