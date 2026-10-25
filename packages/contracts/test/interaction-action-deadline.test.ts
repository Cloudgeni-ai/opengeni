import { describe, expect, test } from "bun:test";
import {
  BrowserActionBatch,
  INTERACTION_ACTION_DEADLINE_FLOOR_MS,
  INTERACTION_ACTION_DEADLINE_MARGIN_MS,
  INTERACTION_ACTION_DEADLINE_MAX_MS,
  browserActionDeadlineMs,
  browserActionMaxWaitMs,
  computerActionDeadlineMs,
  type BrowserAction,
  type ComputerAction,
} from "../src";

const button = { kind: "role" as const, role: "button", name: "Save", exact: true };
const field = { kind: "label" as const, text: "Name" };

describe("browser action deadlines", () => {
  test("a single action keeps the historical one-minute request budget", () => {
    expect(browserActionDeadlineMs({ type: "click", locator: button })).toBe(
      INTERACTION_ACTION_DEADLINE_FLOOR_MS,
    );
    expect(
      browserActionDeadlineMs({ type: "viewport", width: 800, height: 600, mobile: false }),
    ).toBe(60_000);
    // A navigate's own server and document waits already exceed the floor.
    expect(browserActionDeadlineMs({ type: "navigate", url: "https://example.test/" })).toBe(
      20_000 + 30_000 + 2_000 + INTERACTION_ACTION_DEADLINE_MARGIN_MS,
    );
  });

  test("a batch sums each action's declared waits plus one margin", () => {
    const batch = BrowserActionBatch.parse({
      type: "batch",
      actions: [
        { type: "wait", condition: "visible", locator: { kind: "text", text: "Uploaded" } },
        { type: "fill", locator: field, value: "Hello" },
        { type: "press", key: "Enter" },
        {
          type: "wait",
          condition: "visible",
          locator: { kind: "text", text: "Reply" },
          timeoutMs: 90_000,
        },
      ],
    });
    // wait 30 s + locator 10 s; fill locator 10 s; press without locator;
    // wait 90 s + locator 10 s; 2 s dispatch each; one 30 s margin.
    expect(browserActionDeadlineMs(batch)).toBe(40_000 + 10_000 + 0 + 100_000 + 4 * 2_000 + 30_000);
  });

  test("an explicit wait's timeoutMs replaces the default wait", () => {
    const wait = (timeoutMs?: number): BrowserAction => ({
      type: "wait",
      condition: "load",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    expect(browserActionMaxWaitMs(wait())).toBe(30_000 + 2_000);
    expect(browserActionMaxWaitMs(wait(120_000))).toBe(120_000 + 2_000);
    expect(browserActionDeadlineMs(wait(120_000))).toBe(120_000 + 2_000 + 30_000);
  });

  test("a navigate with waitUntil, sent as navigate then wait, gets both bounds", () => {
    const batch = BrowserActionBatch.parse({
      type: "batch",
      actions: [
        { type: "navigate", url: "https://example.test/" },
        { type: "wait", condition: "network_idle" },
      ],
    });
    expect(browserActionDeadlineMs(batch)).toBe(20_000 + 30_000 + 2_000 + 30_000 + 2_000 + 30_000);
  });

  test("locator-bearing actions add one locator wait per locator", () => {
    expect(browserActionMaxWaitMs({ type: "drag", from: button, to: field })).toBe(22_000);
    expect(
      browserActionMaxWaitMs({
        type: "upload",
        locator: button,
        workspaceFileIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    ).toBe(10_000 + 30_000 + 2_000);
  });

  test("is capped at the controller request maximum", () => {
    const batch = BrowserActionBatch.parse({
      type: "batch",
      actions: Array.from({ length: 32 }, () => ({
        type: "wait",
        condition: "visible",
        locator: button,
        timeoutMs: 120_000,
      })),
    });
    expect(browserActionDeadlineMs(batch)).toBe(INTERACTION_ACTION_DEADLINE_MAX_MS);
    expect(INTERACTION_ACTION_DEADLINE_MAX_MS).toBe(20 * 60_000);
  });
});

describe("computer action deadlines", () => {
  const invoke = (locator: Extract<ComputerAction, { type: "semantic" }>["locator"]) =>
    ({ type: "semantic", locator, action: "invoke" }) as const;

  test("a single action keeps the one-minute floor", () => {
    expect(computerActionDeadlineMs(invoke({ kind: "ref", ref: "e1" }))).toBe(60_000);
    expect(computerActionDeadlineMs({ type: "launch", applicationId: "com.example.app" })).toBe(
      Math.max(60_000, 30_000 + 8_000 + 30_000),
    );
  });

  test("a batch waits for each named element but not for refs", () => {
    const named = { kind: "role" as const, role: "button", name: "OK" };
    const actions = [
      ...Array.from({ length: 10 }, () => invoke(named)),
      invoke({ kind: "ref", ref: "e2" }),
      { type: "keyboard" as const, action: "type" as const, value: "hello" },
    ];
    expect(computerActionDeadlineMs({ type: "batch", actions })).toBe(
      10 * (10_000 + 8_000) + 8_000 + 8_000 + 30_000,
    );
  });
});
