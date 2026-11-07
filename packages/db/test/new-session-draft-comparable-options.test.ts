import { describe, expect, test } from "bun:test";
import { stableJson } from "@opengeni/contracts";

import {
  comparableNewSessionDraftOptions,
  NEW_SESSION_DRAFT_OPTION_KEYS,
} from "../src/new-session-drafts";

const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  stableJson(comparableNewSessionDraftOptions(a)) ===
  stableJson(comparableNewSessionDraftOptions(b));

describe("the options a saved new-chat draft and its Send are compared on", () => {
  test("cover every draft option in the contract, Agent learning included", () => {
    expect(NEW_SESSION_DRAFT_OPTION_KEYS).toContain("agentLearning");
    expect(NEW_SESSION_DRAFT_OPTION_KEYS).toContain("excludedMcpServerIds");
  });

  test("keep a set Agent learning override, so a different one still differs", () => {
    expect(comparableNewSessionDraftOptions({ agentLearning: { knowledge: "off" } })).toEqual({
      agentLearning: { knowledge: "off" },
    });
    expect(same({ agentLearning: { knowledge: "off" } }, {})).toBe(false);
    expect(
      same(
        { agentLearning: { knowledge: "off" } },
        { agentLearning: { knowledge: "review_first" } },
      ),
    ).toBe(false);
  });

  test("treat absent, null and an override with nothing set as not set", () => {
    expect(same({ agentLearning: {} }, {})).toBe(true);
    expect(same({ agentLearning: { knowledge: undefined } }, {})).toBe(true);
    expect(same({ goal: null, rigId: null }, {})).toBe(true);
  });

  test("keep an empty list, which is a deliberate choice", () => {
    expect(comparableNewSessionDraftOptions({ excludedMcpServerIds: [] })).toEqual({
      excludedMcpServerIds: [],
    });
    expect(same({ excludedMcpServerIds: [] }, {})).toBe(false);
  });

  test("ignore create fields that are not draft options", () => {
    expect(
      comparableNewSessionDraftOptions({
        visibility: "private",
        ...({ idempotencyKey: "k", initialMessage: "hi" } as Record<string, unknown>),
      }),
    ).toEqual({ visibility: "private" });
  });
});
