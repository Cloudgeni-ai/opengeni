import { describe, expect, test } from "bun:test";
import type { OpStreamConnection } from "@opengeni/events";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { chooseWorkbook, excelAddinInstallUrl } from "../src/mcp/excel-tools";
import {
  clampTimeout,
  mintOfficeWorkbookTicket,
  OfficeWorkbookConnection,
  OfficeWorkbookRelay,
  verifyOfficeWorkbookTicket,
  type OfficeWorkbook,
} from "../src/office-workbooks";

const SECRET = "test-office-ticket-secret";
const DECODE = new TextDecoder();

/** A minimal NATS core pub/sub shared by every relay in a test. */
class FakeOpStream implements OpStreamConnection {
  private readonly subscribers = new Map<string, Set<(data: Uint8Array) => void>>();

  subscribe(subject: string) {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (data: Uint8Array) => {
      queue.push(data);
      wake?.();
    };
    const set = this.subscribers.get(subject) ?? new Set();
    set.add(push);
    this.subscribers.set(subject, set);
    return {
      unsubscribe: () => {
        done = true;
        set.delete(push);
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (done) return;
          const next = queue.shift();
          if (next) {
            yield { data: next };
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      },
    };
  }

  publish(subject: string, payload: Uint8Array): void {
    for (const push of this.subscribers.get(subject) ?? []) push(payload);
  }

  async flush(): Promise<void> {}
}

class SharedBus extends MemoryEventBus {
  constructor(private readonly stream: FakeOpStream) {
    super();
  }
  getOpStreamConnection(): OpStreamConnection {
    return this.stream;
  }
}

/** An add-in on the other end of a socket: answers runs with `answer`. */
function fakeAddin(
  connection: OfficeWorkbookConnection,
  answer: (frame: { id: string; code: string }) => Record<string, unknown> | null,
) {
  const sent: Record<string, unknown>[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  connection.attach({
    data: connection,
    send(data: Uint8Array) {
      const frame = JSON.parse(DECODE.decode(data)) as Record<string, unknown>;
      sent.push(frame);
      if (frame["type"] === "run") {
        const reply = answer(frame as { id: string; code: string });
        if (reply) queueMicrotask(() => connection.receive(JSON.stringify(reply)));
      }
      return data.length;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  });
  return { sent, closed };
}

function hello(connection: OfficeWorkbookConnection, subjectId: string, name: string) {
  connection.receive(
    JSON.stringify({
      type: "hello",
      ticket: mintOfficeWorkbookTicket(SECRET, subjectId).ticket,
      workbook: { name, app: "Excel on the web", version: "16.0", excelApi: "1.17" },
    }),
  );
}

describe("office workbook tickets", () => {
  test("a minted ticket names its subject until it expires", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const { ticket, expiresAt } = mintOfficeWorkbookTicket(SECRET, "user:a", now);
    expect(verifyOfficeWorkbookTicket(SECRET, ticket, now + 1_000)).toBe("user:a");
    expect(Date.parse(expiresAt)).toBe(now + 120_000);
    expect(verifyOfficeWorkbookTicket(SECRET, ticket, now + 120_000)).toBeNull();
  });

  test("forged, re-signed or malformed tickets are refused", () => {
    const { ticket } = mintOfficeWorkbookTicket(SECRET, "user:a");
    const [body, signature] = ticket.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, sub: "user:b", exp: Date.now() + 60_000, n: "x" }),
    ).toString("base64url");
    expect(verifyOfficeWorkbookTicket(SECRET, `${forgedBody}.${signature}`)).toBeNull();
    expect(verifyOfficeWorkbookTicket("other-secret", ticket)).toBeNull();
    expect(verifyOfficeWorkbookTicket(SECRET, `${body}`)).toBeNull();
    expect(verifyOfficeWorkbookTicket(SECRET, `${ticket}.extra`)).toBeNull();
    expect(verifyOfficeWorkbookTicket(SECRET, "")).toBeNull();
  });
});

describe("office workbook relay", () => {
  test("runs code in the person's own workbook and returns the add-in's result", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    const addin = fakeAddin(connection, (frame) => ({
      type: "result",
      id: frame.id,
      ok: true,
      value: { echoed: frame.code },
      logs: ["hi"],
      durationMs: 12,
    }));
    hello(connection, "user:a", "Budget.xlsx");
    expect(addin.sent[0]).toEqual({ type: "ready", connectionId: connection.id });

    const workbooks = await relay.list("user:a");
    expect(workbooks.map((each) => each.name)).toEqual(["Budget.xlsx"]);
    expect(await relay.list("user:b")).toEqual([]);

    expect(await relay.run("user:a", connection.id, "return 1", 5_000)).toEqual({
      kind: "ok",
      value: { echoed: "return 1" },
      logs: ["hi"],
      durationMs: 12,
    });
    // Another person cannot reach it even with its id.
    expect(await relay.run("user:b", connection.id, "return 1", 5_000)).toEqual({
      kind: "disconnected",
    });
  });

  test("maps the add-in's Office error", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    fakeAddin(connection, (frame) => ({
      type: "result",
      id: frame.id,
      ok: false,
      error: {
        name: "RichApi.Error",
        code: "ItemNotFound",
        message: "The requested resource doesn't exist.",
        location: "Workbook.worksheets.getItem",
        statement: 'var sheet = worksheets.getItem("Nope");',
      },
      logs: [],
      durationMs: 40,
    }));
    hello(connection, "user:a", "Budget.xlsx");
    const outcome = await relay.run("user:a", connection.id, "x", 5_000);
    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "ItemNotFound", location: "Workbook.worksheets.getItem" },
    });
  });

  test("a socket that closes mid-run reports an unknown outcome, then disconnected", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    fakeAddin(connection, () => null);
    hello(connection, "user:a", "Budget.xlsx");
    const running = relay.run("user:a", connection.id, "await never()", 5_000);
    connection.transportClosed();
    expect(await running).toMatchObject({ kind: "unknown" });
    expect(await relay.list("user:a")).toEqual([]);
    expect(await relay.run("user:a", connection.id, "return 1", 5_000)).toEqual({
      kind: "disconnected",
    });
  });

  test("no result in time is unknown, not a failure", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    fakeAddin(connection, () => null);
    hello(connection, "user:a", "Budget.xlsx");
    expect(await connection.run("x", 20)).toMatchObject({ kind: "unknown" });
  });

  test("refuses a socket without a valid hello", () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const noHello = new OfficeWorkbookConnection(relay);
    const first = fakeAddin(noHello, () => null);
    noHello.receive(JSON.stringify({ type: "ping" }));
    expect(first.closed).toEqual([{ code: 4400, reason: "hello_required" }]);

    const badTicket = new OfficeWorkbookConnection(relay);
    const second = fakeAddin(badTicket, () => null);
    badTicket.receive(
      JSON.stringify({ type: "hello", ticket: "nope.nope", workbook: { name: "Budget" } }),
    );
    expect(second.closed).toEqual([{ code: 4401, reason: "invalid_ticket" }]);
  });

  test("another API instance reaches the socket and lists it", async () => {
    const stream = new FakeOpStream();
    const bus = new SharedBus(stream);
    const holder = new OfficeWorkbookRelay(bus, SECRET, { presenceWindowMs: 20 });
    const other = new OfficeWorkbookRelay(bus, SECRET, { presenceWindowMs: 20 });
    const connection = new OfficeWorkbookConnection(holder);
    fakeAddin(connection, (frame) => ({ type: "result", id: frame.id, ok: true, value: 7 }));
    hello(connection, "user:a", "Budget.xlsx");

    const listed = await other.list("user:a");
    expect(listed.map((each) => each.id)).toEqual([connection.id]);
    expect(await other.list("user:b")).toEqual([]);
    expect(await other.run("user:a", connection.id, "return 7", 5_000)).toMatchObject({
      kind: "ok",
      value: 7,
    });
    expect(await other.run("user:b", connection.id, "return 7", 5_000)).toEqual({
      kind: "disconnected",
    });
    connection.transportClosed();
    expect(await other.run("user:a", connection.id, "return 7", 5_000)).toEqual({
      kind: "disconnected",
    });
    expect(await other.list("user:a")).toEqual([]);
  });

  test("clamps run timeouts", () => {
    expect(clampTimeout(5)).toBe(1_000);
    expect(clampTimeout(30_000)).toBe(30_000);
    expect(clampTimeout(10_000_000)).toBe(120_000);
  });
});

describe("chooseWorkbook", () => {
  const book = (id: string, name: string): OfficeWorkbook => ({
    id,
    name,
    app: "Excel on the web",
    version: null,
    excelApi: null,
    connectedAt: "2026-10-20T12:00:00.000Z",
  });

  test("needs a connected workbook", () => {
    expect(chooseWorkbook([], undefined)).toMatchObject({
      error: expect.stringContaining("No Excel workbook is connected"),
    });
  });

  test("links the add-in install page when no workbook is connected", () => {
    const result = chooseWorkbook([], undefined, excelAddinInstallUrl("https://app.example/"));
    const error = "error" in result ? result.error : "";
    expect(error).toContain("give them this link");
    expect(error.endsWith(" https://app.example/excel")).toBe(true);
    expect(excelAddinInstallUrl(null)).toBeNull();
  });

  test("uses the only open workbook when none is named", () => {
    expect(chooseWorkbook([book("a", "Budget.xlsx")], undefined)).toEqual({
      workbook: book("a", "Budget.xlsx"),
    });
  });

  test("asks which one when several are open", () => {
    const result = chooseWorkbook([book("a", "Budget.xlsx"), book("b", "Sales.xlsx")], " ");
    expect(result).toMatchObject({ error: expect.stringContaining('"Sales.xlsx" (id b') });
  });

  test("matches by id, by name and by name without its extension", () => {
    const books = [book("a", "Budget.xlsx"), book("b", "Sales.xlsx")];
    expect(chooseWorkbook(books, "b")).toEqual({ workbook: books[1]! });
    expect(chooseWorkbook(books, "budget.XLSX")).toEqual({ workbook: books[0]! });
    expect(chooseWorkbook(books, "sales")).toEqual({ workbook: books[1]! });
    expect(chooseWorkbook(books, "Forecast")).toMatchObject({
      error: expect.stringContaining('No open workbook matches "Forecast"'),
    });
  });

  test("asks for the id when two open workbooks share a name", () => {
    const books = [book("a", "Book 1"), book("b", "Book 1")];
    expect(chooseWorkbook(books, "Book 1")).toMatchObject({
      error: expect.stringContaining("pass its id"),
    });
  });
});
