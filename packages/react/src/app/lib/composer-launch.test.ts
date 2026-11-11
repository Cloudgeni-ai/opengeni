import { describe, expect, test } from "bun:test";

import {
  composerLaunchSearchAfterPolicyApply,
  composerLaunchSearchKey,
  modelProvidedAfterLaunch,
  parseComposerLaunchSearch,
} from "./composer-launch";
import { creditCheckoutSuccessUrl } from "./model-access-onboarding";

describe("parseComposerLaunchSearch", () => {
  test("accepts model, effort, latency, realtime, a folder, and one selected Skill", () => {
    expect(
      parseComposerLaunchSearch({
        model: " codex/gpt-5.6-sol ",
        effort: "xhigh",
        latency: "fast",
        realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
        channelId: "00000000-0000-4000-8000-0000000000a1",
        skillCapabilityId: "skill:product-integration@abc",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-sol",
      effort: "xhigh",
      latency: "fast",
      realtime: "opengeni-gateway/openai/gpt-realtime-2.1",
      channelId: "00000000-0000-4000-8000-0000000000a1",
      skillCapabilityId: "skill:product-integration@abc",
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

    expect(ordinary.channelId).toBeUndefined();
    expect(defaultFolder.channelId).toBe("default");
  });

  test("key and leftover search helpers", () => {
    const full = parseComposerLaunchSearch({
      model: "gpt-5.6-sol",
      effort: "low",
      latency: "standard",
      realtime: "gpt-live-1-boulder-alpha",
      skillCapabilityId: "skill:product-integration@abc",
    });
    expect(composerLaunchSearchKey(full)).toContain("gpt-5.6-sol");
    expect(composerLaunchSearchAfterPolicyApply(full)).toEqual({
      realtime: "gpt-live-1-boulder-alpha",
      skillCapabilityId: "skill:product-integration@abc",
    });
    expect(composerLaunchSearchAfterPolicyApply({ model: "gpt-5.6-sol" })).toEqual({});
    expect(composerLaunchSearchKey({})).toBeNull();
  });

  test("a credit-purchase return keeps following the default instead of pinning a choice", () => {
    const returned = new URL(
      creditCheckoutSuccessUrl("https://app.example.test", "workspace-a", {
        id: "gpt-6-luna",
        effort: "xhigh",
      }),
    );
    const launch = parseComposerLaunchSearch(Object.fromEntries(returned.searchParams));
    expect(launch).toEqual({ model: "gpt-6-luna", effort: "xhigh", followDefault: true });
    // The draft stays on the default, so a later subscription connect moves it.
    expect(modelProvidedAfterLaunch(launch, false)).toBe(false);
    expect(modelProvidedAfterLaunch(launch, true)).toBe(false);
    // An older server that reports no marker gets none back.
    expect(modelProvidedAfterLaunch(launch, undefined)).toBeUndefined();
    expect(composerLaunchSearchKey(launch)).not.toBe(
      composerLaunchSearchKey({ model: "gpt-6-luna", effort: "xhigh" }),
    );
  });

  test("any other launch policy is the person's choice", () => {
    expect(modelProvidedAfterLaunch({ model: "codex/gpt-5.6-sol" }, false)).toBe(true);
    expect(modelProvidedAfterLaunch({ effort: "low" }, undefined)).toBe(true);
    // A launch without policy leaves the marker alone.
    expect(modelProvidedAfterLaunch({ channelId: "default" }, false)).toBe(false);
    expect(modelProvidedAfterLaunch({ followDefault: true }, false)).toBe(false);
  });
});
