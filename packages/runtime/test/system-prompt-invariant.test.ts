// The system prompt of one chat must not depend on anything that changes from
// turn to turn. Claude binds signed thinking to it, and both providers cache
// the request prefix that starts with it. Per-turn content belongs in history
// (context items, the turn's operational notice), where earlier requests keep
// their bytes.
//
// The chat below runs the real agent build, input preparation and run loop
// over turns that each change every per-turn input in PER_TURN_INPUTS. To
// cover a new per-turn input, add an entry: its name, and what it sets on
// each turn.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { renderSessionGoalContext } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniAgent, GENESIS_TITLE_DIRECTIVE, prepareRunInput } from "../src/index";
import { chat, claudeModel, liveBox, responsesModel, type TurnOptions } from "./live-chat-fixture";

type Box = Awaited<ReturnType<typeof liveBox>>;
type Turn = {
  index: number;
  box: Box;
  options: TurnOptions & { build: NonNullable<TurnOptions["build"]> };
  notices: string[];
};

const TURNS = 5;
const GOAL = {
  goalId: "11111111-1111-4111-8111-111111111111",
  objectiveRevision: 1,
  text: "Ship the release",
  successCriteria: "The release is live",
  rootConstraints: [],
  mutationPolicy: "review_changes" as const,
  capturedAt: "2026-11-10T10:00:00.000Z",
};

/** Every per-turn input, by name, and what it is on turn `index` (0-based). */
const PER_TURN_INPUTS: Array<{ name: string; apply: (turn: Turn) => Promise<void> | void }> = [
  {
    name: "a repository Skill added mid-chat",
    apply: async ({ index, box }) => {
      if (index === 1) await box.addSkill("beta");
    },
  },
  {
    name: "repository Skills degraded, then unreachable, then restored",
    apply: ({ index, box }) => {
      box.setOffline(index === 2);
      if (index === 1) box.setDegraded(true);
      else if (index !== 2) box.setDegraded(false);
    },
  },
  {
    name: "deferred versus indexed repository Skill discovery",
    apply: ({ index, options }) => {
      options.deferred = index === 3;
    },
  },
  {
    name: "session title missing, then set",
    apply: ({ index, options }) => {
      if (index < 2) options.build.missingSessionTitleHint = true;
      else options.build.persistentSessionSettings = { titleIsSet: true };
    },
  },
  {
    name: "the current time",
    apply: ({ index }) => {
      setSystemTime(new Date(Date.UTC(2026, 10, 10 + index, 9 + index, 17 * index)));
    },
  },
  {
    name: "standing goal state",
    apply: ({ index, notices }) => {
      const goal = [
        renderSessionGoalContext({ state: "none", capturedAt: GOAL.capturedAt }),
        renderSessionGoalContext({ state: "active", ...GOAL }),
        renderSessionGoalContext({ state: "paused", ...GOAL }),
        renderSessionGoalContext({ state: "active", ...GOAL, objectiveRevision: 2 }),
        renderSessionGoalContext({ state: "completed", ...GOAL }),
      ][index];
      if (goal) notices.push(goal);
    },
  },
  {
    name: "turn notes",
    apply: ({ index, notices }) => {
      if (index % 2 === 1) notices.push(`Task note ${index}: the staging deploy is pending.`);
    },
  },
  {
    name: "credit and usage notices",
    apply: ({ index, notices }) => {
      if (index === 2)
        notices.push("Workspace credits are low: 3% of this month's allowance remains.");
    },
  },
  {
    name: "sandbox restore and unreachable notices",
    apply: ({ index, notices }) => {
      if (index === 2) notices.push("The workspace's Connected Machine was offline for this turn.");
      if (index === 4) notices.push("The sandbox was restored from a snapshot taken at 09:12 UTC.");
    },
  },
  {
    name: "connector availability",
    apply: ({ index, options }) => {
      if (index === 1) options.build.unavailableMcpServers = new Map([["slack", "signed out"]]);
    },
  },
  {
    name: "unattended execution of this turn",
    apply: ({ index, options }) => {
      if (index === 3) options.build.unattendedNow = true;
    },
  },
  {
    name: "tool calls approved for this turn",
    apply: ({ index, options }) => {
      if (index === 4) options.build.approvedToolCallIds = ["call_approved"];
    },
  },
  {
    name: "reasoning effort",
    apply: ({ index, options }) => {
      options.build.reasoningEffort = index % 2 === 0 ? "high" : "low";
    },
  },
];

afterEach(() => {
  setSystemTime();
});

describe.each([
  ["Claude", claudeModel],
  ["Responses", responsesModel],
])("%s: the system prompt does not depend on per-turn inputs", (_name, wire) => {
  test(`one system prompt across turns that change ${PER_TURN_INPUTS.length} per-turn inputs`, async () => {
    const box = await liveBox();
    await box.addSkill("alpha");
    // The first turn calls a tool, so it sends two requests.
    const { api, model, bodies, system, conversation } = wire(["tool"]);
    const conversationChat = chat(box, model, api);
    for (let index = 0; index < TURNS; index++) {
      const turn: Turn = { index, box, options: { build: {} }, notices: [] };
      for (const input of PER_TURN_INPUTS) await input.apply(turn);
      await conversationChat.turn(`turn ${index}`, {
        ...turn.options,
        ...(turn.notices.length ? { internalContext: turn.notices.join("\n\n") } : {}),
      });
    }

    expect(bodies).toHaveLength(TURNS + 1);
    const prompts = bodies.map(system);
    for (const [index, prompt] of prompts.entries()) {
      // Name the request that differs, so a failure says which inputs to check.
      expect({ request: index, prompt }).toEqual({ request: index, prompt: prompts[0]! });
    }
    // The per-turn content still reaches the model, as history.
    const sent = JSON.stringify(conversation(bodies.at(-1)));
    expect(prompts[0]).not.toContain("still needs a semantic display title");
    expect(sent).toContain(JSON.stringify(GENESIS_TITLE_DIRECTIVE).slice(1, -1));
    expect(sent).toContain("Task note 3");
    expect(sent).toContain("Workspace credits are low");
    expect(sent).toContain("restored from a snapshot");
    expect(sent).toContain("Ship the release");
    expect(sent).toContain("the workspace was unreachable");
    expect(sent).toContain("could not be indexed");
  }, 60_000);
});

test("a missing title is requested once per agent, in the turn notice", async () => {
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
    missingSessionTitleHint: true,
  });
  const historyItems = [{ type: "message", role: "user", content: "Hello" }];
  const first = await prepareRunInput(agent, { kind: "message", historyItems } as never);
  // Input prepared again for the same agent (a nudge, a retry after
  // compaction) follows a run that already saw the request.
  const again = await prepareRunInput(agent, { kind: "message", historyItems } as never);
  expect(JSON.stringify(first.input)).toContain("still needs a semantic display title");
  expect(JSON.stringify(again.input)).not.toContain("still needs a semantic display title");
  expect(JSON.stringify(agent.instructions)).not.toContain("still needs a semantic display title");
});
