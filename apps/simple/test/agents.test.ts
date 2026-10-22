import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";
import { organizeSidebar, toAgents } from "../src/lib/agents";

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function session(id: string, overrides: Partial<Session> & { role?: string } = {}): Session {
  const { role = "agent", ...rest } = overrides;
  return {
    id,
    title: id,
    status: "idle",
    archived: false,
    pinned: false,
    pinnedAt: null,
    createdAt: iso(30 * DAY),
    updatedAt: iso(DAY),
    metadata: { simpleApp: { kind: "agent", role } },
    ...rest,
  } as unknown as Session;
}

const ids = (sections: ReturnType<typeof organizeSidebar>) =>
  Object.fromEntries(
    sections.map((section) => [section.id, section.agents.map((agent) => agent.id)]),
  );

describe("toAgents", () => {
  test("keeps only the app's live agents and names the main one Geni", () => {
    const agents = toAgents(
      [
        session("main", { role: "main", title: "whatever" }),
        session("archived", { archived: true }),
        session("studio", { metadata: { simpleApp: { kind: "studio" } } } as Partial<Session>),
        session("other", { metadata: {} } as Partial<Session>),
        session("agent"),
      ],
      [],
      [],
    );
    expect(agents.map((agent) => agent.id)).toEqual(["main", "agent"]);
    expect(agents[0]?.name).toBe("Geni");
  });

  test("derives working and needs-you from status", () => {
    const [running, waiting] = toAgents(
      [session("a", { status: "running" }), session("b", { status: "requires_action" })],
      [],
      [],
    );
    expect(running?.working).toBe(true);
    expect(waiting?.needsYou).toBe(true);
  });
});

describe("organizeSidebar", () => {
  test("Geni first, then pins in pin order, then agents by use", () => {
    const agents = toAgents(
      [
        session("main", { role: "main" }),
        session("pin-late", { pinned: true, pinnedAt: iso(DAY) }),
        session("pin-early", { pinned: true, pinnedAt: iso(2 * DAY) }),
        session("rare"),
        session("frequent"),
      ],
      [],
      [
        { sessionId: "rare", score: 1, lastUsedAt: iso(DAY) },
        { sessionId: "frequent", score: 9, lastUsedAt: iso(DAY) },
      ],
    );
    expect(ids(organizeSidebar(agents))).toEqual({
      main: ["main"],
      pinned: ["pin-early", "pin-late"],
      agents: ["frequent", "rare"],
    });
  });

  test("lifts agents that need the person above heavier-used ones", () => {
    const agents = toAgents(
      [session("busy"), session("asking", { status: "requires_action" })],
      [],
      [{ sessionId: "busy", score: 50, lastUsedAt: iso(DAY) }],
    );
    expect(ids(organizeSidebar(agents)).agents).toEqual(["asking", "busy"]);
  });

  test("folds untouched agents into Quiet but spares new ones", () => {
    const agents = toAgents(
      [
        session("old", { updatedAt: iso(20 * DAY), createdAt: iso(60 * DAY) }),
        session("new", { updatedAt: iso(20 * DAY), createdAt: iso(DAY) }),
      ],
      [],
      [],
    );
    const sections = organizeSidebar(agents);
    expect(ids(sections).quiet).toEqual(["old"]);
    expect(ids(sections).agents).toEqual(["new"]);
    expect(sections.find((section) => section.id === "quiet")?.collapsible).toBe(true);
  });
});
