// Keeps this workbook connected to Opengeni so the person's agents in one
// workspace can run Office.js in it (the `excel_run` tool), from the pane's
// chat or any other of their chats there.
import { excel } from "./host";
import { runOfficeCode, serialQueue, type RunResult } from "./executor";
import type { OfficeWorkbookTicket, RetainedArtifactReference } from "../types";
import { describeWorkbook, type OfficeWorkbookInfo } from "./workbook";
import {
  bytesToBase64,
  readWorkbookFile,
  workbookCopyFilename,
  XLSX_CONTENT_TYPE,
  type OfficeRunFile,
} from "./workbook-file";

export type { OfficeWorkbookTicket };

export type WorkbookLinkState =
  | { status: "connecting" }
  | { status: "connected"; connectionId: string }
  | { status: "offline"; retryInMs: number }
  | { status: "signed_out" };

/**
 * Moves files between the chat and the workbook as the signed-in person,
 * normally `client.downloadRetainedArtifact` and `client.uploadFile` in the
 * pane's workspace. Without it, agents can't open chat files in the workbook
 * or save a copy of it to the chat.
 */
export type WorkbookFiles = {
  download(artifact: RetainedArtifactReference): Promise<Uint8Array>;
  /** Upload a copy of the workbook with the scope the API chose for the chat it goes to. */
  upload(file: {
    filename: string;
    contentType: string;
    data: Uint8Array;
    scope: "personal" | "workspace";
  }): Promise<{ id: string }>;
};

/** A chat file the API hands to agent code. */
export type WorkbookRunFile = { name: string; artifact: RetainedArtifactReference };

/** What a run does besides the code: files in, a copy of the workbook out. */
export type WorkbookRunRequest = {
  code: string;
  files: readonly WorkbookRunFile[];
  /** Save a copy of the workbook under this name, with this scope, after the code ran. */
  saveCopy: { filename: string; scope: "personal" | "workspace" } | null;
};

/** A run's result, with the uploaded copy of the workbook when one was asked for. */
export type WorkbookRunResult = RunResult & {
  copy?: { fileId: string; filename: string } | { error: string };
};

export type WorkbookLinkOptions = {
  /**
   * Mints a ticket for the workspace, normally
   * `() => client.createOfficeWorkbookTicket(workspaceId)`. A rejection with
   * `status: 401` means signed out; any other failure is retried.
   */
  ticket: () => Promise<OfficeWorkbookTicket>;
  /**
   * Where the socket connects: the Opengeni API's base URL as the pane reaches
   * it (absolute, or a same-origin path such as "/api/opengeni" when the
   * product's server passes the socket through); the ticket's path is
   * appended. Omit it to use the ticket's `url` on the deployment's public API.
   */
  baseUrl?: string;
  onState: (state: WorkbookLinkState) => void;
  /** Agent code started (true) or finished (false) in this workbook. */
  onActivity?: (busy: boolean) => void;
  /** Defaults to `describeWorkbook()`. */
  describe?: () => Promise<OfficeWorkbookInfo>;
  /** Lets agents open chat files in the workbook and save copies of it to the chat. */
  files?: WorkbookFiles;
  /** Defaults to running the code in this workbook with office.js. */
  run?: (code: string, files: readonly OfficeRunFile[]) => Promise<RunResult>;
  /** Defaults to `readWorkbookFile()`. */
  readFile?: () => Promise<Uint8Array>;
};

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

/** The socket URL for `path` under `baseUrl`, resolved against `pageUrl` when relative. */
export function websocketUrl(baseUrl: string, path: string, pageUrl?: string): string {
  const base = new URL(
    baseUrl.replace(/\/+$/u, "") + "/",
    pageUrl ?? globalThis.location?.href ?? "http://localhost/",
  );
  const url = new URL(path.replace(/^\/+/u, ""), base);
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
  private readonly describe: () => Promise<OfficeWorkbookInfo>;
  private readonly run: (code: string, files: readonly OfficeRunFile[]) => Promise<RunResult>;
  private readonly readFile: () => Promise<Uint8Array>;

  constructor(private readonly options: WorkbookLinkOptions) {
    this.describe = options.describe ?? describeWorkbook;
    this.run =
      options.run ??
      ((code, files) =>
        runOfficeCode(code, (batch) => excel().run(batch), excel(), undefined, files));
    this.readFile = options.readFile ?? readWorkbookFile;
  }

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
    this.socket.send(JSON.stringify({ type: "workbook", workbook: await this.describe() }));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.options.onState({ status: "connecting" });
    let ticket: OfficeWorkbookTicket;
    let workbook: OfficeWorkbookInfo;
    try {
      ticket = await this.options.ticket();
      workbook = await this.describe();
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 401) {
        this.options.onState({ status: "signed_out" });
        return;
      }
      this.retry();
      return;
    }
    if (this.stopped) return;
    const target = this.options.baseUrl
      ? websocketUrl(this.options.baseUrl, ticket.path)
      : ticket.url;
    if (!target) {
      // A setup error retrying cannot fix.
      console.error("WorkbookLink needs baseUrl: this deployment's tickets carry no socket URL");
      this.options.onState({ status: "offline", retryInMs: 0 });
      return;
    }
    const socket = new WebSocket(target, ticket.protocol);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "hello", ticket: ticket.ticket, workbook }));
    socket.onmessage = (event) => {
      const text =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let frame: {
        type?: string;
        connectionId?: string;
        id?: string;
        code?: string;
        files?: unknown;
        saveCopy?: unknown;
      };
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
        const { id } = frame;
        const request: WorkbookRunRequest = {
          code: frame.code,
          files: runFiles(frame.files),
          saveCopy: saveCopy(frame.saveCopy),
        };
        void this.queue(async () => {
          this.activity(1);
          try {
            const result = await this.execute(request);
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

  /** Bring in the files, run the code, then save a copy of the workbook when asked. */
  async execute(request: WorkbookRunRequest): Promise<WorkbookRunResult> {
    const files = this.options.files;
    const needsFiles = request.files.length > 0 || request.saveCopy !== null;
    if (needsFiles && !files) {
      return failure(
        "FilesUnavailable",
        "This add-in can't move files between the chat and the workbook.",
      );
    }
    let inputs: OfficeRunFile[] = [];
    try {
      inputs = await Promise.all(
        request.files.map(async (each) => ({
          artifactId: each.artifact.artifactId,
          name: each.name,
          contentType: each.artifact.contentType,
          base64: bytesToBase64(await files!.download(each.artifact)),
        })),
      );
    } catch (error) {
      return failure("FileDownloadFailed", `Couldn't open a chat file here: ${message(error)}`);
    }
    const result: WorkbookRunResult = await this.run(request.code, inputs);
    if (!result.ok || request.saveCopy === null) return result;
    const filename = workbookCopyFilename(request.saveCopy.filename);
    try {
      const data = await this.readFile();
      const uploaded = await files!.upload({
        filename,
        contentType: XLSX_CONTENT_TYPE,
        data,
        scope: request.saveCopy.scope,
      });
      return { ...result, copy: { fileId: uploaded.id, filename } };
    } catch (error) {
      return { ...result, copy: { error: message(error) } };
    }
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

function runFiles(value: unknown): WorkbookRunFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each) => {
    const record = each as { name?: unknown; artifact?: unknown } | null;
    const artifact = record?.artifact as RetainedArtifactReference | undefined;
    return typeof record?.name === "string" &&
      artifact &&
      typeof artifact === "object" &&
      typeof artifact.artifactId === "string"
      ? [{ name: record.name, artifact }]
      : [];
  });
}

function saveCopy(value: unknown): WorkbookRunRequest["saveCopy"] {
  const record = value as { filename?: unknown; scope?: unknown } | null;
  if (typeof record !== "object" || record === null) return null;
  if (typeof record.filename !== "string" || !record.filename.trim()) return null;
  return {
    filename: record.filename,
    scope: record.scope === "workspace" ? "workspace" : "personal",
  };
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function failure(name: string, text: string): WorkbookRunResult {
  return {
    ok: false,
    error: { name, code: null, message: text, location: null, statement: null },
    logs: [],
    durationMs: 0,
  };
}
