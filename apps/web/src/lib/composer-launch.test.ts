import { describe, expect, test } from "bun:test";

import {
  composerLaunchChannelId,
  composerLaunchSearchAfterPolicyApply,
  composerLaunchSearchForChannel,
  composerLaunchSearchKey,
  parseComposerLaunchSearch,
  resolveComposerLaunchChannelId,
} from "./composer-launch";

describe("parseComposerLaunchSearch", () => {
  test("accepts model, effort, latency, realtime, a folder, and one selected Skill", () => {
    expect(
      parseComposerLaunchSearch({
        model: " codex/gpt-5.6-sol ",
        effort: "xhigh",
        latency: "fast",
        realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
        channelId: "00000000-0000-4000-8000-0000000000a1",
        skillCapabilityId: "skill:pack-inline/opengeni-product-integration@abc",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-sol",
      effort: "xhigh",
      latency: "fast",
      realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
      channelId: "00000000-0000-4000-8000-0000000000a1",
      skillCapabilityId: "skill:pack-inline/opengeni-product-integration@abc",
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
        channelId: "not-a-folder-id",
      }),
    ).toEqual({});
  });

  test("keeps an explicit Default-folder launch distinct from an ordinary new session", () => {
    const ordinary = parseComposerLaunchSearch({});
    const defaultFolder = parseComposerLaunchSearch({ channelId: "default" });

    expect(composerLaunchChannelId(ordinary)).toBeUndefined();
    expect(composerLaunchChannelId(defaultFolder)).toBeNull();
    expect(
      resolveComposerLaunchChannelId(
        composerLaunchChannelId(defaultFolder),
        "00000000-0000-4000-8000-0000000000b2",
      ),
    ).toBeNull();
    expect(
      resolveComposerLaunchChannelId(
        composerLaunchChannelId(ordinary),
        "00000000-0000-4000-8000-0000000000b2",
      ),
    ).toBe("00000000-0000-4000-8000-0000000000b2");
    expect(composerLaunchSearchForChannel(undefined)).toEqual({});
    expect(composerLaunchSearchForChannel(null)).toEqual({ channelId: "default" });
    expect(
      composerLaunchChannelId(
        composerLaunchSearchForChannel("00000000-0000-4000-8000-0000000000a1"),
      ),
    ).toBe("00000000-0000-4000-8000-0000000000a1");
  });

  test("key and leftover search helpers", () => {
    const full = parseComposerLaunchSearch({
      model: "gpt-5.6-sol",
      effort: "low",
      latency: "standard",
      realtime: "gpt-live-1-boulder-alpha",
      skillCapabilityId: "skill:pack-inline/opengeni-product-integration@abc",
    });
    expect(composerLaunchSearchKey(full)).toContain("gpt-5.6-sol");
    expect(composerLaunchSearchAfterPolicyApply(full)).toEqual({
      realtime: "gpt-live-1-boulder-alpha",
      skillCapabilityId: "skill:pack-inline/opengeni-product-integration@abc",
    });
    expect(composerLaunchSearchAfterPolicyApply({ model: "gpt-5.6-sol" })).toEqual({});
    expect(composerLaunchSearchKey({})).toBeNull();
  });
});
