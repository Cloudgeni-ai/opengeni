import { describe, expect, test } from "bun:test";

import type { SupportCase } from "./types";
import {
  TICKET_HISTORY_LIMIT,
  VisitorProductStates,
  addActivity,
  addNote,
  addReply,
} from "./visitor-state";

function seed(): SupportCase[] {
  return [
    {
      customer: {
        id: "cus_1",
        name: "Customer",
        initials: "CU",
        plan: "Scale",
        arr: 1,
        healthScore: 1,
        joinedAt: "2026-01-01T00:00:00.000Z",
        primaryContact: { name: "Contact", role: "Lead", email: "contact@example.test" },
        recentUsage: {
          activeSeats: 1,
          totalSeats: 1,
          exportsLast30Days: 1,
          failedExportsLast7Days: 0,
        },
      },
      ticket: {
        id: "TKT-1",
        customerId: "cus_1",
        subject: "Subject",
        body: "Body",
        status: "open",
        priority: "normal",
        assignee: "Agent",
        channel: "email",
        createdAt: "2026-01-01T00:00:00.000Z",
        slaDueAt: "2026-01-01T01:00:00.000Z",
        tags: [],
        notes: [],
        replies: [],
        activity: [],
        inbox: "mine",
        unread: true,
      },
    },
  ];
}

function note(body: string) {
  return {
    id: crypto.randomUUID(),
    author: "Maya Chen",
    authorKind: "human" as const,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function collector() {
  const frames: string[] = [];
  const decoder = new TextDecoder();
  const controller = {
    enqueue: (chunk: Uint8Array) => frames.push(decoder.decode(chunk)),
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { frames, controller };
}

describe("VisitorProductStates", () => {
  test("gives each visitor its own copy and leaves the seed untouched", () => {
    const states = new VisitorProductStates(seed());
    const seedState = states.read("visitor-a");
    // Reads share the seed, which cannot be changed by accident.
    expect(states.read("visitor-b")).toBe(seedState);
    expect(() => seedState.cases[0]!.ticket.notes.push(note("x"))).toThrow(TypeError);
    expect(() => {
      seedState.cases[0]!.ticket.status = "resolved";
    }).toThrow(TypeError);

    const own = states.writable("visitor-a");
    addNote(own.cases[0]!.ticket, note("only for a"));
    expect(states.read("visitor-a").cases[0]!.ticket.notes[0]!.body).toBe("only for a");
    expect(states.read("visitor-b").cases[0]!.ticket.notes).toEqual([]);
    expect(states.writable("visitor-a")).toBe(own);

    // A reset drops only that visitor's changes.
    states.writable("visitor-b").cases[0]!.ticket.status = "resolved";
    expect(states.reset("visitor-a")).toBe(seedState);
    expect(states.read("visitor-a").cases[0]!.ticket.notes).toEqual([]);
    expect(states.read("visitor-b").cases[0]!.ticket.status).toBe("resolved");
  });

  test("does not share the caller's seed objects", () => {
    const source = seed();
    const states = new VisitorProductStates(source);
    source[0]!.ticket.subject = "Changed after start";
    expect(states.read("visitor-a").cases[0]!.ticket.subject).toBe("Subject");
  });

  test("delivers events only to the visitor they belong to", () => {
    const states = new VisitorProductStates(seed());
    const a = collector();
    const b = collector();
    const unsubscribeA = states.subscribe("visitor-a", a.controller);
    states.subscribe("visitor-b", b.controller);
    const state = states.writable("visitor-a");
    const event = states.emit("visitor-a", state, "ticket.note_added", "Added", "TKT-1");
    expect(event.revision).toBe(2);
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toContain("event: ticket.note_added");
    expect(b.frames).toEqual([]);
    unsubscribeA();
    states.emit("visitor-a", state, "ticket.updated", "Updated", "TKT-1");
    expect(a.frames).toHaveLength(1);
    // A reset event reports the seed's revision without changing the seed.
    expect(
      states.emit("visitor-b", states.reset("visitor-b"), "demo.reset", "Reset", "all").revision,
    ).toBe(1);
  });

  test("forgets the least recently active visitor first and tells its pages", () => {
    const states = new VisitorProductStates(seed(), 2);
    const b = collector();
    states.subscribe("visitor-b", b.controller);
    states.writable("visitor-a").cases[0]!.ticket.status = "resolved";
    states.writable("visitor-b").cases[0]!.ticket.status = "resolved";
    // Reading visitor-a keeps it; visitor-b is now the oldest.
    states.read("visitor-a");
    states.writable("visitor-c").cases[0]!.ticket.status = "resolved";
    expect(states.read("visitor-a").cases[0]!.ticket.status).toBe("resolved");
    expect(states.read("visitor-b").cases[0]!.ticket.status).toBe("open");
    expect(states.read("visitor-c").cases[0]!.ticket.status).toBe("resolved");
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]).toContain("event: demo.reset");
    expect(b.frames[0]).toContain('"revision":1');
  });

  test("drops a stream that can no longer receive", () => {
    const states = new VisitorProductStates(seed());
    let calls = 0;
    const closed = {
      enqueue: () => {
        calls += 1;
        throw new TypeError("closed");
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    states.subscribe("visitor-a", closed);
    const state = states.writable("visitor-a");
    states.emit("visitor-a", state, "ticket.updated", "Updated", "TKT-1");
    states.emit("visitor-a", state, "ticket.updated", "Updated", "TKT-1");
    expect(calls).toBe(1);
  });
});

describe("ticket history caps", () => {
  test("keep only the newest notes, replies, and activity", () => {
    const states = new VisitorProductStates(seed());
    const { ticket } = states.writable("visitor-a").cases[0]!;
    for (let index = 0; index < TICKET_HISTORY_LIMIT + 10; index += 1) {
      addNote(ticket, note(`note ${index}`));
      addReply(ticket, {
        id: crypto.randomUUID(),
        author: "Maya Chen",
        body: `reply ${index}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      addActivity(ticket, "Maya Chen", `activity ${index}`);
    }
    const newest = TICKET_HISTORY_LIMIT + 9;
    expect(ticket.notes).toHaveLength(TICKET_HISTORY_LIMIT);
    expect(ticket.notes[0]!.body).toBe(`note ${newest}`);
    expect(ticket.replies).toHaveLength(TICKET_HISTORY_LIMIT);
    // Replies read oldest first; the newest stays last.
    expect(ticket.replies.at(-1)!.body).toBe(`reply ${newest}`);
    expect(ticket.replies[0]!.body).toBe("reply 10");
    expect(ticket.activity).toHaveLength(TICKET_HISTORY_LIMIT);
    expect(ticket.activity[0]!.summary).toBe(`activity ${newest}`);
  });
});
