// Keeps this workbook connected to Opengeni so the person's agents can run
// Office.js in it (the API's `excel_run`), from this pane or any other chat.
import { serialQueue, type RunResult } from "./executor";

export type WorkbookInfo = {
  name: string;
  app: string;
  version: string | null;
  excelApi: string | null;
};

export type WorkbookLinkState =
  | { status: "connecting" }
  | { status: "connected"; connectionId: string }
  | { status: "offline"; retryInMs: number }
  | { status: "signed_out" };

export type WorkbookLinkOptions = {
  apiBaseUrl: string;
  token: () => string | null;
  describe: () => Promise<WorkbookInfo>;
  run: (code: string) => Promise<RunResult>;
  onState: (state: WorkbookLinkState) => void;
  /** Agent code started (true) or finished (false) in this workbook. */
  onActivity?: (busy: boolean) => void;
};

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

export function websocketUrl(apiBaseUrl: string, path: string): string {
  const url = new URL(path, apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class WorkbookLink {
  private socket: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue = serialQueue();
  private running = 0;

  constructor(private readonly options: WorkbookLinkOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close(1000, "closed");
    this.socket = null;
  }

  /** Tell agents the workbook's new name (after Save As or a rename). */
  async refresh(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "workbook", workbook: await this.options.describe() }));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = this.options.token();
    if (!token) {
      this.options.onState({ status: "signed_out" });
      return;
    }
    this.options.onState({ status: "connecting" });
    let ticket: { ticket: string; path: string; protocol: string };
    let workbook: WorkbookInfo;
    try {
      const response = await fetch(`${this.options.apiBaseUrl}/v1/office/workbook-tickets`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        this.options.onState({ status: "signed_out" });
        return;
      }
      if (!response.ok) throw new Error(`ticket ${response.status}`);
      ticket = (await response.json()) as typeof ticket;
      workbook = await this.options.describe();
    } catch {
      this.retry();
      return;
    }
    if (this.stopped) return;
    const socket = new WebSocket(
      websocketUrl(this.options.apiBaseUrl, ticket.path),
      ticket.protocol,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "hello", ticket: ticket.ticket, workbook }));
    socket.onmessage = (event) => {
      const text =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let frame: { type?: string; connectionId?: string; id?: string; code?: string };
      try {
        frame = JSON.parse(text) as typeof frame;
      } catch {
        return;
      }
      if (frame.type === "ready" && frame.connectionId) {
        this.backoffMs = 1_000;
        this.options.onState({ status: "connected", connectionId: frame.connectionId });
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
        }, PING_MS);
      } else if (frame.type === "run" && frame.id && typeof frame.code === "string") {
        const { id, code } = frame;
        void this.queue(async () => {
          this.activity(1);
          try {
            const result = await this.options.run(code);
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "result", id, ...result }));
            }
          } finally {
            this.activity(-1);
          }
        });
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (event.code === 4401) {
        // The ticket was refused: get a fresh one (and notice a signed-out token).
        this.backoffMs = 1_000;
      }
      this.retry();
    };
  }

  private activity(delta: number): void {
    const before = this.running;
    this.running += delta;
    if ((before === 0) !== (this.running === 0)) this.options.onActivity?.(this.running > 0);
  }

  private retry(): void {
    if (this.stopped) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.options.onState({ status: "offline", retryInMs: wait });
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }
}

/** What this Office host reports about the open workbook. */
export async function describeWorkbook(): Promise<WorkbookInfo> {
  let name: string | null = null;
  try {
    name = await Excel.run(async (context) => {
      context.workbook.load("name");
      await context.sync();
      return context.workbook.name;
    });
  } catch {
    name = null;
  }
  if (!name) {
    const url = Office.context.document?.url ?? "";
    name = decodeURIComponent(url.split(/[\\/]/u).pop()?.split("?")[0] ?? "") || null;
  }
  const diagnostics = Office.context.diagnostics;
  const platform = diagnostics?.platform ?? Office.context.platform ?? "";
  const app =
    platform === "OfficeOnline"
      ? "Excel on the web"
      : platform === "Mac"
        ? "Excel for Mac"
        : platform === "PC"
          ? "Excel for Windows"
          : platform === "iOS"
            ? "Excel for iPad"
            : "Excel";
  const versions = ["1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12"];
  const excelApi =
    versions.find((version) => Office.context.requirements.isSetSupported("ExcelApi", version)) ??
    null;
  return {
    name: name ?? "Untitled workbook",
    app,
    version: diagnostics?.version ?? null,
    excelApi,
  };
}
