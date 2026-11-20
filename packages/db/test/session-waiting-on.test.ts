import { describe, expect, test } from "bun:test";
import { currentSessionWaitingOn, storedSessionLinks } from "../src/index";

const updatedAt = new Date("2026-11-20T10:00:00.000Z");
const agentWait = {
  source: "agent" as const,
  person: "Kari",
  subjectId: null,
  reason: "review the pull request",
  since: "2026-11-20T09:00:00.000Z",
  turnId: "turn-1",
};

describe("who a chat waits on", () => {
  test("an open question or approval waits on the person the turn works for", () => {
    expect(
      currentSessionWaitingOn(
        { status: "requires_action", activeTurnId: "turn-2", waitingOn: agentWait, updatedAt },
        { initiatorSubjectId: "user:ada", latestTurnId: "turn-2" },
      ),
    ).toEqual({
      source: "input",
      person: null,
      subjectId: "user:ada",
      reason: null,
      since: updatedAt.toISOString(),
    });
  });

  test("the agent's wait shows while the chat is idle after the turn that set it", () => {
    const { turnId: _turnId, ...shown } = agentWait;
    expect(
      currentSessionWaitingOn(
        { status: "idle", activeTurnId: null, waitingOn: agentWait, updatedAt },
        { initiatorSubjectId: null, latestTurnId: "turn-1" },
      ),
    ).toEqual(shown);
  });

  test("a later turn, a running turn or no wait clears it", () => {
    expect(
      currentSessionWaitingOn(
        { status: "idle", activeTurnId: null, waitingOn: agentWait, updatedAt },
        { initiatorSubjectId: null, latestTurnId: "turn-3" },
      ),
    ).toBeNull();
    expect(
      currentSessionWaitingOn(
        { status: "running", activeTurnId: "turn-1", waitingOn: agentWait, updatedAt },
        { initiatorSubjectId: null, latestTurnId: "turn-1" },
      ),
    ).toBeNull();
    expect(
      currentSessionWaitingOn(
        { status: "idle", activeTurnId: null, waitingOn: null, updatedAt },
        { initiatorSubjectId: null, latestTurnId: "turn-1" },
      ),
    ).toBeNull();
    expect(
      currentSessionWaitingOn(
        {
          status: "idle",
          activeTurnId: null,
          waitingOn: { ...agentWait, turnId: null },
          updatedAt,
        },
        { initiatorSubjectId: null, latestTurnId: null },
      ),
    ).toBeNull();
  });
});

describe("stored links", () => {
  test("one bad entry is dropped, not the whole list", () => {
    const good = {
      id: "l1",
      url: "https://github.com/acme/api/pull/7",
      title: null,
      kind: "pull_request" as const,
      provider: "github" as const,
      ref: "acme/api#7",
      addedBy: "agent" as const,
      addedAt: "2026-11-20T10:00:00.000Z",
    };
    expect(storedSessionLinks([good, { ...good, id: "l2", ref: "x".repeat(301) }])).toEqual([good]);
    expect(storedSessionLinks(null)).toEqual([]);
  });
});
