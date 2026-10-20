// Live Excel workbooks.
//
// The Opengeni Office add-in, open in a person's workbook, holds one WebSocket
// to an API instance. Agents working for that person run Office.js code in the
// workbook (the `excel_run` tool) through it. Nothing is stored: a workbook is
// reachable exactly while its add-in is connected.
//
// Routing uses the bus's NATS connection, so any API instance reaches a socket
// held by another:
// - `office.workbook.<connectionId>.run`: request/reply to the instance that
//   holds that socket.
// - `office.workbooks.<ownerKey>.presence`: an instance lists a person's open
//   workbooks by publishing one query and collecting every instance's answer
//   for a short window.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { EventBus, OpStreamConnection } from "@opengeni/events";
import type {
  ApiWebSocketConnection,
  ApiWebSocketLike,
  ApiWebSocketUpgradeServer,
} from "./api-websocket";

export const OFFICE_WORKBOOK_WEBSOCKET_PATH = "/v1/office/workbooks/live";
export const OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL = "opengeni-office-v1";
export const OFFICE_RUN_DEFAULT_TIMEOUT_MS = 60_000;
export const OFFICE_RUN_MAX_TIMEOUT_MS = 120_000;
const TICKET_TTL_MS = 2 * 60_000;
const HELLO_TIMEOUT_MS = 15_000;
const PRESENCE_WINDOW_MS = 250;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const TEXT = new TextEncoder();
const DECODE = new TextDecoder();

/** What the add-in reports about the workbook it is open in. */
export type OfficeWorkbookInfo = {
  name: string;
  /** "Excel on the web", "Excel for Mac", "Excel for Windows"... */
  app: string;
  /** Office build, for diagnostics. */
  version: string | null;
  /** Highest supported ExcelApi requirement set, e.g. "1.17". */
  excelApi: string | null;
};

/** One open workbook as an agent sees it. */
export type OfficeWorkbook = OfficeWorkbookInfo & {
  id: string;
  connectedAt: string;
};

export type OfficeRunError = {
  name: string;
  code: string | null;
  message: string;
  location: string | null;
  statement: string | null;
};

export type OfficeRunOutcome =
  | { kind: "ok"; value: unknown; logs: string[]; durationMs: number }
  | { kind: "error"; error: OfficeRunError; logs: string[]; durationMs: number }
  /** No add-in holds this workbook any more. */
  | { kind: "disconnected" }
  /** The code was delivered but no result came back in time; it may have run. */
  | { kind: "unknown"; reason: string };

// ---------------------------------------------------------------------------
// Tickets: the socket is authenticated by a short-lived signed ticket minted by
// an ordinary authenticated HTTP request, so every API auth mode works alike.
// ---------------------------------------------------------------------------

type TicketClaims = { v: 1; sub: string; exp: number; n: string };

export function mintOfficeWorkbookTicket(
  secret: string,
  subjectId: string,
  now = Date.now(),
): { ticket: string; expiresAt: string } {
  const claims: TicketClaims = {
    v: 1,
    sub: subjectId,
    exp: now + TICKET_TTL_MS,
    n: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return {
    ticket: `${body}.${ticketSignature(secret, body)}`,
    expiresAt: new Date(claims.exp).toISOString(),
  };
}

/** The ticket's subject, or null when it is forged, malformed or expired. */
export function verifyOfficeWorkbookTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
): string | null {
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(ticketSignature(secret, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketClaims;
    if (claims.v !== 1 || typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

function ticketSignature(secret: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`opengeni/office-workbook-ticket/v1\n${body}`, "utf8")
    .digest("base64url");
}

/** A NATS-safe token for a subject id (which may contain `.` or `:`). */
function ownerKey(subjectId: string): string {
  return createHash("sha256").update(subjectId, "utf8").digest("hex").slice(0, 40);
}

const runSubject = (connectionId: string) => `office.workbook.${connectionId}.run`;
const presenceSubject = (subjectId: string) => `office.workbooks.${ownerKey(subjectId)}.presence`;

// ---------------------------------------------------------------------------
// Relay: this instance's sockets plus cross-instance routing.
// ---------------------------------------------------------------------------

type RunRequest = { owner: string; code: string; timeoutMs: number };

export class OfficeWorkbookRelay {
  private readonly local = new Map<string, OfficeWorkbookConnection>();
  private readonly presence = new Map<string, () => void>();
  private readonly runSubscriptions = new Map<string, () => void>();

  constructor(
    private readonly bus: EventBus,
    readonly ticketSecret: string,
    private readonly options: { presenceWindowMs?: number } = {},
  ) {}

  /** The person's open workbooks across every API instance, newest first. */
  async list(subjectId: string): Promise<OfficeWorkbook[]> {
    const found = new Map<string, OfficeWorkbook>();
    for (const connection of this.local.values()) {
      const workbook = connection.describe();
      if (connection.subjectId === subjectId && workbook) found.set(workbook.id, workbook);
    }
    const nats = this.nats();
    if (nats) {
      const inbox = `office.workbooks.reply.${randomBytes(12).toString("hex")}`;
      const subscription = nats.subscribe(inbox);
      const collected = (async () => {
        for await (const message of subscription) {
          for (const workbook of parseWorkbooks(message.data)) {
            if (!found.has(workbook.id)) found.set(workbook.id, workbook);
          }
        }
      })().catch(() => undefined);
      await nats.flush?.();
      nats.publish(presenceSubject(subjectId), TEXT.encode(JSON.stringify({ reply: inbox })));
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.presenceWindowMs ?? PRESENCE_WINDOW_MS),
      );
      subscription.unsubscribe();
      await collected;
    }
    return [...found.values()].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  }

  /** Run Office.js code in one of the person's workbooks. */
  async run(
    subjectId: string,
    workbookId: string,
    code: string,
    timeoutMs: number,
  ): Promise<OfficeRunOutcome> {
    const local = this.local.get(workbookId);
    if (local) {
      return local.subjectId === subjectId
        ? await local.run(code, timeoutMs)
        : { kind: "disconnected" };
    }
    const request: RunRequest = { owner: subjectId, code, timeoutMs };
    try {
      const reply = await this.bus.request(
        runSubject(workbookId),
        TEXT.encode(JSON.stringify(request)),
        // The holder answers `unknown` itself at timeoutMs; this only covers a
        // holder that vanished mid-run.
        { timeoutMs: timeoutMs + 5_000 },
      );
      return JSON.parse(DECODE.decode(reply.data)) as OfficeRunOutcome;
    } catch (error) {
      const code_ = (error as { code?: unknown })?.code;
      if (code_ === "503" || code_ === 503) return { kind: "disconnected" };
      return {
        kind: "unknown",
        reason: "The workbook stopped answering while the code ran.",
      };
    }
  }

  register(connection: OfficeWorkbookConnection): void {
    this.local.set(connection.id, connection);
    this.runSubscriptions.set(
      connection.id,
      this.bus.subscribeRequests(runSubject(connection.id), async (bytes) => {
        const request = JSON.parse(DECODE.decode(bytes)) as RunRequest;
        const outcome: OfficeRunOutcome =
          request.owner === connection.subjectId && this.local.get(connection.id) === connection
            ? await connection.run(
                String(request.code),
                clampTimeout(Number(request.timeoutMs) || OFFICE_RUN_DEFAULT_TIMEOUT_MS),
              )
            : { kind: "disconnected" };
        return TEXT.encode(JSON.stringify(outcome));
      }),
    );
    const key = ownerKey(connection.subjectId);
    if (!this.presence.has(key)) {
      const nats = this.nats();
      if (nats) {
        const subscription = nats.subscribe(presenceSubject(connection.subjectId));
        void (async () => {
          for await (const message of subscription) {
            let reply: unknown;
            try {
              reply = (JSON.parse(DECODE.decode(message.data)) as { reply?: unknown }).reply;
            } catch {
              continue;
            }
            if (typeof reply !== "string" || !reply.startsWith("office.workbooks.reply.")) continue;
            const workbooks = [...this.local.values()]
              .filter((each) => each.subjectId === connection.subjectId)
              .flatMap((each) => {
                const workbook = each.describe();
                return workbook ? [workbook] : [];
              });
            if (workbooks.length > 0) nats.publish(reply, TEXT.encode(JSON.stringify(workbooks)));
          }
        })().catch(() => undefined);
        this.presence.set(key, () => subscription.unsubscribe());
      }
    }
  }

  unregister(connection: OfficeWorkbookConnection): void {
    if (this.local.get(connection.id) !== connection) return;
    this.local.delete(connection.id);
    this.runSubscriptions.get(connection.id)?.();
    this.runSubscriptions.delete(connection.id);
    const stillHeld = [...this.local.values()].some(
      (each) => each.subjectId === connection.subjectId,
    );
    if (!stillHeld) {
      const key = ownerKey(connection.subjectId);
      this.presence.get(key)?.();
      this.presence.delete(key);
    }
  }

  private nats(): OpStreamConnection | null {
    return this.bus.getOpStreamConnection?.() ?? null;
  }
}

function parseWorkbooks(bytes: Uint8Array): OfficeWorkbook[] {
  try {
    const value = JSON.parse(DECODE.decode(bytes)) as unknown;
    return Array.isArray(value)
      ? value.filter(
          (each): each is OfficeWorkbook =>
            typeof each === "object" &&
            each !== null &&
            typeof (each as OfficeWorkbook).id === "string" &&
            typeof (each as OfficeWorkbook).name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function clampTimeout(timeoutMs: number): number {
  return Math.min(Math.max(Math.round(timeoutMs), 1_000), OFFICE_RUN_MAX_TIMEOUT_MS);
}

const relays = new WeakMap<EventBus, OfficeWorkbookRelay>();

/** The process's relay for this bus (the WebSocket transport and the tool share it). */
export function officeWorkbookRelay(bus: EventBus, ticketSecret: string): OfficeWorkbookRelay {
  let relay = relays.get(bus);
  if (!relay) {
    relay = new OfficeWorkbookRelay(bus, ticketSecret);
    relays.set(bus, relay);
  }
  return relay;
}

// ---------------------------------------------------------------------------
// The socket. JSON text frames:
//   add-in -> API: hello {ticket, workbook}, workbook {workbook}, result {...}, ping
//   API -> add-in: ready {connectionId}, run {id, code, timeoutMs}, pong
// ---------------------------------------------------------------------------

type PendingRun = {
  resolve: (outcome: OfficeRunOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OfficeWorkbookConnection implements ApiWebSocketConnection {
  readonly id = randomBytes(16).toString("hex");
  subjectId = "";
  private socket: ApiWebSocketLike | null = null;
  private workbook: OfficeWorkbookInfo | null = null;
  private connectedAt = new Date().toISOString();
  private readonly pending = new Map<string, PendingRun>();
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly relay: OfficeWorkbookRelay) {}

  attach(socket: ApiWebSocketLike): void {
    if (this.socket || this.closed) {
      socket.close(4400, "invalid connection state");
      return;
    }
    this.socket = socket;
    this.helloTimer = setTimeout(() => this.fail(4401, "hello_timeout"), HELLO_TIMEOUT_MS);
  }

  describe(): OfficeWorkbook | null {
    if (!this.workbook || this.closed) return null;
    return { id: this.id, connectedAt: this.connectedAt, ...this.workbook };
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) return;
    const raw = typeof message === "string" ? message : DECODE.decode(message);
    if (raw.length > MAX_FRAME_CHARS) return this.fail(4409, "oversized_frame");
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.fail(4400, "invalid_frame");
    }
    if (!this.subjectId) {
      if (frame["type"] !== "hello") return this.fail(4400, "hello_required");
      const subjectId =
        typeof frame["ticket"] === "string"
          ? verifyOfficeWorkbookTicket(this.relay.ticketSecret, frame["ticket"])
          : null;
      const workbook = workbookInfo(frame["workbook"]);
      if (!subjectId) return this.fail(4401, "invalid_ticket");
      if (!workbook) return this.fail(4400, "invalid_workbook");
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.subjectId = subjectId;
      this.workbook = workbook;
      this.connectedAt = new Date().toISOString();
      this.relay.register(this);
      this.send({ type: "ready", connectionId: this.id });
      return;
    }
    switch (frame["type"]) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "workbook": {
        const workbook = workbookInfo(frame["workbook"]);
        if (workbook) this.workbook = workbook;
        return;
      }
      case "result": {
        const id = typeof frame["id"] === "string" ? frame["id"] : "";
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(runOutcome(frame));
        return;
      }
      default:
        return;
    }
  }

  run(code: string, timeoutMs: number): Promise<OfficeRunOutcome> {
    if (this.closed || !this.socket) return Promise.resolve({ kind: "disconnected" });
    const id = randomBytes(8).toString("hex");
    return new Promise<OfficeRunOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          kind: "unknown",
          reason: `No result within ${Math.round(timeoutMs / 1000)} seconds. The code may still be running in the workbook.`,
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      if (!this.send({ type: "run", id, code, timeoutMs })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ kind: "disconnected" });
      }
    });
  }

  transportClosed(): void {
    this.shutdown();
  }

  private send(frame: Record<string, unknown>): boolean {
    if (!this.socket || this.closed) return false;
    const accepted = this.socket.send(TEXT.encode(JSON.stringify(frame)), false);
    return Number.isSafeInteger(accepted) && accepted > 0;
  }

  private fail(code: number, reason: string): void {
    const socket = this.socket;
    this.shutdown();
    socket?.close(code, reason);
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.relay.unregister(this);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      // The code reached the add-in, so it may have run before the socket closed.
      pending.resolve({
        kind: "unknown",
        reason: "The add-in disconnected while the code ran. It may or may not have run.",
      });
    }
  }
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function workbookInfo(value: unknown): OfficeWorkbookInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = text(record["name"], 255);
  if (!name) return null;
  return {
    name,
    app: text(record["app"], 80) ?? "Excel",
    version: text(record["version"], 40),
    excelApi: text(record["excelApi"], 10),
  };
}

function runOutcome(frame: Record<string, unknown>): OfficeRunOutcome {
  const logs = Array.isArray(frame["logs"])
    ? frame["logs"].filter((each): each is string => typeof each === "string").slice(0, 200)
    : [];
  const durationMs = Number.isFinite(frame["durationMs"]) ? Number(frame["durationMs"]) : 0;
  if (frame["ok"] === true) return { kind: "ok", value: frame["value"], logs, durationMs };
  const error =
    typeof frame["error"] === "object" && frame["error"] !== null
      ? (frame["error"] as Record<string, unknown>)
      : {};
  return {
    kind: "error",
    error: {
      name: text(error["name"], 120) ?? "Error",
      code: text(error["code"], 120),
      message: text(error["message"], 4000) ?? "The code failed.",
      location: text(error["location"], 400),
      statement: text(error["statement"], 2000),
    },
    logs,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Upgrade route.
// ---------------------------------------------------------------------------

export class OfficeWorkbookWebSocketTransport {
  constructor(private readonly relay: OfficeWorkbookRelay) {}

  handles(request: Request): boolean {
    return new URL(request.url).pathname === OFFICE_WORKBOOK_WEBSOCKET_PATH;
  }

  upgrade(request: Request, server: ApiWebSocketUpgradeServer): Response | undefined {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
    }
    const offered = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim())
      .includes(OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL);
    if (!offered) return new Response("WebSocket protocol required", { status: 426 });
    const upgraded = server.upgrade(request, {
      data: new OfficeWorkbookConnection(this.relay),
      headers: { "sec-websocket-protocol": OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL },
    });
    return upgraded ? undefined : new Response("Bad Request", { status: 400 });
  }
}
