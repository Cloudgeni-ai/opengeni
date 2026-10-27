import { describe, expect, test } from "bun:test";
import {
  AGENT_INPUT_MARGIN_MS,
  AgentInput,
  newestReading,
  PERSON_EVENT_TYPES,
  reachesHidTimers,
  recentPersonInput,
} from "../src/cua/macos-person-input";

describe("macOS person input", () => {
  test("the most recent reading counts, and readings that are not a time are skipped", () => {
    expect(newestReading([90, 3.5, 12])).toBe(3.5);
    expect(newestReading([Number.NaN, -1, Number.POSITIVE_INFINITY, 7])).toBe(7);
    expect(newestReading([Number.NaN])).toBeNull();
    expect(newestReading([])).toBeNull();
  });

  test("only input within the last minute is reported, in whole seconds", () => {
    expect(recentPersonInput(0.4)).toBe(0);
    expect(recentPersonInput(59.9)).toBe(59);
    expect(recentPersonInput(60)).toBeUndefined();
    expect(recentPersonInput(null)).toBeUndefined();
  });

  test("every kind of a person's input is asked once, and only types with their own timer", () => {
    expect(new Set(PERSON_EVENT_TYPES).size).toBe(PERSON_EVENT_TYPES.length);
    for (const type of [1, 5, 10, 12, 22]) expect(PERSON_EVENT_TYPES).toContain(type);
    // A type the HID system answers with its any-event timer would count the
    // keys agents send to apps in the background.
    expect(PERSON_EVENT_TYPES.every((type) => type < 32)).toBe(true);
  });

  test("input that came within the margin after an agent's, or while it is sent, is the agent's", async () => {
    let now = 50_000;
    const agent = new AgentInput(() => now);
    expect(agent.personOnly(30)).toBe(30);
    expect(agent.personOnly(null)).toBeNull();
    let reading: number | null = -1;
    await agent.around(async () => {
      now += 1_000;
      reading = agent.personOnly(5);
    });
    // While input is being sent, nothing can be told apart from it.
    expect(reading).toBeNull();
    now += 2_000;
    // Ended 2 s ago: input 2.5 s ago, or within the margin after, is the agent's.
    expect(agent.personOnly(2.5)).toBeNull();
    expect(agent.personOnly(2 - AGENT_INPUT_MARGIN_MS / 1000)).toBeNull();
    expect(agent.personOnly(1)).toBe(1);
    // A failed send counts too: its input may have gone out.
    await agent
      .around(async () => {
        throw new Error("failed");
      })
      .catch(() => undefined);
    expect(agent.personOnly(1)).toBeNull();
  });

  test("calls that ask for the foreground or the whole desktop anywhere may reach the HID timers", () => {
    expect(reachesHidTimers("press_key", { key: "tab" })).toBe(false);
    expect(reachesHidTimers("press_key", { key: "tab", delivery_mode: "background" })).toBe(false);
    expect(reachesHidTimers("click", { delivery_mode: "Foreground" })).toBe(true);
    expect(reachesHidTimers("move_cursor", { scope: "desktop", x: 1, y: 1 })).toBe(true);
    expect(reachesHidTimers("run_steps", { steps: [{ tool: "click", args: {} }] })).toBe(false);
    expect(reachesHidTimers("run_steps", { steps: [], foreground_fallback: true })).toBe(true);
    expect(
      reachesHidTimers("run_steps", {
        steps: [{ click: {} }, { tool: "press_key", args: { delivery_mode: "foreground" } }],
      }),
    ).toBe(true);
    // A script can send either.
    expect(reachesHidTimers("run_script", { script: "return 1" })).toBe(true);
  });
});
