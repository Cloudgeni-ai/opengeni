import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { Database, EventSourceRecord } from "@opengeni/db";
import {
  chooseSlackSourceTeam,
  forEachSlackSource,
  recordSlackEvent,
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

  test("nothing is read while event triggers are off", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be used");
        },
      },
    ) as Database;
    await recordSlackEvent({
      db,
      settings: { eventTriggersEnabled: false } as Settings,
      accountId: "account",
      workspaceId: "home",
      connectionId: "bot",
      teamId: "T0123",
      body: new Uint8Array(),
    });
  });
});
