import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { Database, EventSourceRecord } from "@opengeni/db";
import {
  chooseSlackSourceTeam,
  forEachSlackSource,
  recordSlackEvent,
  SHARED_SLACK_DELIVERY_CONCURRENCY,
  slackTeamSourceKey,
} from "../src/domain/event-triggers/slack-source";

describe("the Slack team a Slack source listens to", () => {
  const none = () => false;

  test("a bot installed here comes before one the organization shares", () => {
    expect(
      chooseSlackSourceTeam({
        localTeamIds: ["T_LOCAL"],
        sharedTeamIds: ["T_SHARED"],
        hasSource: none,
      }),
    ).toBe("T_LOCAL");
  });

  test("a shared bot is enough", () => {
    expect(
      chooseSlackSourceTeam({ localTeamIds: [], sharedTeamIds: ["T_SHARED"], hasSource: none }),
    ).toBe("T_SHARED");
  });

  test("the next team without a source, else the first again", () => {
    const input = { localTeamIds: ["T_A"], sharedTeamIds: ["T_A", "T_B"] };
    expect(chooseSlackSourceTeam({ ...input, hasSource: (team) => team === "T_A" })).toBe("T_B");
    expect(chooseSlackSourceTeam({ ...input, hasSource: () => true })).toBe("T_A");
  });

  test("none without any bot", () => {
    expect(chooseSlackSourceTeam({ localTeamIds: [], sharedTeamIds: [], hasSource: none })).toBe(
      null,
    );
  });

  test("the source key names the team", () => {
    expect(slackTeamSourceKey("T0123")).toBe("team:T0123");
  });
});

describe("recording a Slack callback into several workspaces", () => {
  const source = (workspaceId: string) =>
    ({ id: `source-${workspaceId}`, workspaceId }) as EventSourceRecord;

  test("a failure in one workspace leaves the others recorded", async () => {
    const recorded: string[] = [];
    const failed: string[] = [];
    await forEachSlackSource(
      [source("home"), source("broken"), source("shared")],
      async (entry) => {
        if (entry.workspaceId === "broken") throw new Error("unavailable");
        recorded.push(entry.workspaceId);
      },
      (entry) => failed.push(entry.workspaceId),
    );
    expect(recorded).toEqual(["home", "shared"]);
    expect(failed).toEqual(["broken"]);
  });

  test("shared workspaces are written a few at a time, each once", async () => {
    let running = 0;
    let peak = 0;
    const recorded: string[] = [];
    const names = Array.from({ length: 10 }, (_, index) => `shared-${index}`);
    await forEachSlackSource(
      names.map(source),
      async (entry) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        recorded.push(entry.workspaceId);
        running -= 1;
      },
      () => {
        throw new Error("no failure expected");
      },
      SHARED_SLACK_DELIVERY_CONCURRENCY,
    );
    expect(peak).toBe(SHARED_SLACK_DELIVERY_CONCURRENCY);
    expect(recorded.toSorted()).toEqual(names.toSorted());
  });

  test("nothing is read while event triggers are off", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be used");
        },
      },
    ) as Database;
    const recorded = await recordSlackEvent({
      db,
      settings: { eventTriggersEnabled: false } as Settings,
      accountId: "account",
      workspaceId: "home",
      connectionId: "bot",
      teamId: "T0123",
      body: new Uint8Array(),
    });
    await recorded.shared;
  });
});
