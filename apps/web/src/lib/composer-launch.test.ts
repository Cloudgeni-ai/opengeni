import { describe, expect, test } from "bun:test";

import {
  composerLaunchSearchAfterPolicyApply,
  composerLaunchSearchKey,
  parseComposerLaunchSearch,
} from "./composer-launch";

describe("parseComposerLaunchSearch", () => {
  test("accepts model, effort, latency, and realtime", () => {
    expect(
      parseComposerLaunchSearch({
        model: " codex/gpt-5.6-sol ",
        effort: "xhigh",
        latency: "fast",
        realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-sol",
      effort: "xhigh",
      latency: "fast",
      realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
    });
  });

  test("drops unknown or empty values", () => {
    expect(
      parseComposerLaunchSearch({
        model: "   ",
        effort: "ludicrous",
        latency: "turbo",
        realtime: "not-a-realtime-model",
        other: "x",
      }),
    ).toEqual({});
  });

  test("key and leftover search helpers", () => {
    const full = parseComposerLaunchSearch({
      model: "gpt-5.6-sol",
      effort: "low",
      latency: "standard",
      realtime: "gpt-live-1-boulder-alpha",
    });
    expect(composerLaunchSearchKey(full)).toContain("gpt-5.6-sol");
    expect(composerLaunchSearchAfterPolicyApply(full)).toEqual({
      realtime: "gpt-live-1-boulder-alpha",
    });
    expect(composerLaunchSearchAfterPolicyApply({ model: "gpt-5.6-sol" })).toEqual({});
    expect(composerLaunchSearchKey({})).toBeNull();
  });
});
