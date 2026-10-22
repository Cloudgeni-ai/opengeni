import { describe, expect, test } from "bun:test";
import {
  EXCEL_ADDIN_CAPABILITY_ID,
  excelAddinCatalogItem,
  searchCapabilityCatalogItems,
} from "@opengeni/core";
import type { OpStreamConnection } from "@opengeni/events";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { chooseWorkbook, excelAddin } from "../src/mcp/excel-tools";
import {
  clampTimeout,
  mintOfficeWorkbookTicket,
  OfficeWorkbookConnection,
  OfficeWorkbookRelay,
  verifyOfficeWorkbookTicket,
  type OfficeWorkbook,
  type OfficeWorkbookOwner,
} from "../src/office-workbooks";

const SECRET = "test-office-ticket-secret";
const DECODE = new TextDecoder();
const WS1 = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const A: OfficeWorkbookOwner = { subjectId: "user:a", workspaceId: WS1 };
const B: OfficeWorkbookOwner = { subjectId: "user:b", workspaceId: WS1 };
/** The same person (or one service identity acting for many) in another workspace. */
const A2: OfficeWorkbookOwner = { subjectId: "user:a", workspaceId: WS2 };
const ADDIN = { name: "Opengeni", installUrl: null };

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

function hello(connection: OfficeWorkbookConnection, owner: OfficeWorkbookOwner, name: string) {
  connection.receive(
    JSON.stringify({
      type: "hello",
      ticket: mintOfficeWorkbookTicket(SECRET, owner).ticket,
      workbook: { name, app: "Excel on the web", version: "16.0", excelApi: "1.17" },
    }),
  );
}

describe("office workbook tickets", () => {
  test("a minted ticket names its owner until it expires", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const { ticket, expiresAt } = mintOfficeWorkbookTicket(SECRET, A, now);
    expect(verifyOfficeWorkbookTicket(SECRET, ticket, now + 1_000)).toEqual(A);
    expect(Date.parse(expiresAt)).toBe(now + 120_000);
    expect(verifyOfficeWorkbookTicket(SECRET, ticket, now + 120_000)).toBeNull();
  });

  test("forged, re-signed or malformed tickets are refused", () => {
    const { ticket } = mintOfficeWorkbookTicket(SECRET, A);
    const [body, signature] = ticket.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 2, sub: "user:a", ws: WS2, exp: Date.now() + 60_000, n: "x" }),
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
    hello(connection, A, "Budget.xlsx");
    expect(addin.sent[0]).toEqual({ type: "ready", connectionId: connection.id });

    const workbooks = await relay.list(A);
    expect(workbooks.map((each) => each.name)).toEqual(["Budget.xlsx"]);
    expect(await relay.list(B)).toEqual([]);
    expect(await relay.list(A2)).toEqual([]);

    expect(await relay.run(A, connection.id, "return 1", 5_000)).toEqual({
      kind: "ok",
      value: { echoed: "return 1" },
      logs: ["hi"],
      durationMs: 12,
    });
    // Another person cannot reach it even with its id.
    expect(await relay.run(B, connection.id, "return 1", 5_000)).toEqual({
      kind: "disconnected",
    });
    // Nor can the same identity from another workspace.
    expect(await relay.run(A2, connection.id, "return 1", 5_000)).toEqual({
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
    hello(connection, A, "Budget.xlsx");
    const outcome = await relay.run(A, connection.id, "x", 5_000);
    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "ItemNotFound", location: "Workbook.worksheets.getItem" },
    });
  });

  test("a socket that closes mid-run reports an unknown outcome, then disconnected", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    fakeAddin(connection, () => null);
    hello(connection, A, "Budget.xlsx");
    const running = relay.run(A, connection.id, "await never()", 5_000);
    connection.transportClosed();
    expect(await running).toMatchObject({ kind: "unknown" });
    expect(await relay.list(A)).toEqual([]);
    expect(await relay.run(A, connection.id, "return 1", 5_000)).toEqual({
      kind: "disconnected",
    });
  });

  test("no result in time is unknown, not a failure", async () => {
    const relay = new OfficeWorkbookRelay(new MemoryEventBus(), SECRET);
    const connection = new OfficeWorkbookConnection(relay);
    fakeAddin(connection, () => null);
    hello(connection, A, "Budget.xlsx");
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
    hello(connection, A, "Budget.xlsx");

    const listed = await other.list(A);
    expect(listed.map((each) => each.id)).toEqual([connection.id]);
    expect(await other.list(B)).toEqual([]);
    expect(await other.run(A, connection.id, "return 7", 5_000)).toMatchObject({
      kind: "ok",
      value: 7,
    });
    expect(await other.run(B, connection.id, "return 7", 5_000)).toEqual({
      kind: "disconnected",
    });
    expect(await other.list(A2)).toEqual([]);
    expect(await other.run(A2, connection.id, "return 7", 5_000)).toEqual({
      kind: "disconnected",
    });
    connection.transportClosed();
    expect(await other.run(A, connection.id, "return 7", 5_000)).toEqual({
      kind: "disconnected",
    });
    expect(await other.list(A)).toEqual([]);
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
    expect(chooseWorkbook([], undefined, ADDIN)).toMatchObject({
      error: expect.stringContaining("No Excel workbook is connected"),
    });
  });

  test("names the add-in and links its install page when no workbook is connected", () => {
    const result = chooseWorkbook(
      [],
      undefined,
      excelAddin({ webBaseUrl: "https://app.example/" }),
    );
    const error = "error" in result ? result.error : "";
    expect(error).toContain("open the Opengeni add-in");
    expect(error).toContain("give them this link");
    expect(error.endsWith(" https://app.example/excel")).toBe(true);
    expect(excelAddin({}).installUrl).toBeNull();
  });

  test("a product's own add-in is named and linked instead", () => {
    const addin = excelAddin({
      officeAddinName: "Acme",
      officeAddinInstallUrl: "https://acme.example/excel-help",
      webBaseUrl: "https://app.example",
    });
    expect(addin).toEqual({ name: "Acme", installUrl: "https://acme.example/excel-help" });
    const result = chooseWorkbook([], undefined, addin);
    const error = "error" in result ? result.error : "";
    expect(error).toContain("open the Acme add-in (Home > Add-ins > Acme)");
    expect(error).not.toContain("Opengeni");
    expect(error.endsWith(" https://acme.example/excel-help")).toBe(true);
  });

  test("the catalog tile names the product's add-in, links its install page and is found by spreadsheet searches", () => {
    const item = excelAddinCatalogItem(
      excelAddin({ officeAddinName: "Acme", officeAddinInstallUrl: "https://acme.example/excel" }),
    );
    expect(item).toMatchObject({
      id: EXCEL_ADDIN_CAPABILITY_ID,
      kind: "api",
      surfaceType: "first_party_excel_addin",
      enabled: false,
      runtime: { available: true },
      metadata: { addinName: "Acme", installUrl: "https://acme.example/excel" },
    });
    expect(item.description).toContain("Acme add-in");
    expect(item.description).not.toContain("Opengeni");
    for (const query of ["excel", "spreadsheet", "xlsx", "Excel add-in"]) {
      expect(searchCapabilityCatalogItems([item], query, 5).map((each) => each.item.id)).toEqual([
        EXCEL_ADDIN_CAPABILITY_ID,
      ]);
    }
    expect(excelAddinCatalogItem(excelAddin({})).runtime.available).toBe(false);
  });

  test("uses the only open workbook when none is named", () => {
    expect(chooseWorkbook([book("a", "Budget.xlsx")], undefined, ADDIN)).toEqual({
      workbook: book("a", "Budget.xlsx"),
    });
  });

  test("asks which one when several are open", () => {
    const result = chooseWorkbook([book("a", "Budget.xlsx"), book("b", "Sales.xlsx")], " ", ADDIN);
    expect(result).toMatchObject({ error: expect.stringContaining('"Sales.xlsx" (id b') });
  });

  test("matches by id, by name and by name without its extension", () => {
    const books = [book("a", "Budget.xlsx"), book("b", "Sales.xlsx")];
    expect(chooseWorkbook(books, "b", ADDIN)).toEqual({ workbook: books[1]! });
    expect(chooseWorkbook(books, "budget.XLSX", ADDIN)).toEqual({ workbook: books[0]! });
    expect(chooseWorkbook(books, "sales", ADDIN)).toEqual({ workbook: books[1]! });
    expect(chooseWorkbook(books, "Forecast", ADDIN)).toMatchObject({
      error: expect.stringContaining('No open workbook matches "Forecast"'),
    });
  });

  test("asks for the id when two open workbooks share a name", () => {
    const books = [book("a", "Book 1"), book("b", "Book 1")];
    expect(chooseWorkbook(books, "Book 1", ADDIN)).toMatchObject({
      error: expect.stringContaining("pass its id"),
    });
  });
});
