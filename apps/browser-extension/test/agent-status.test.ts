import { describe, expect, test } from "bun:test";

import {
  AGENT_NOT_ACCEPTING,
  AGENT_NOT_SET_UP,
  AGENT_START,
  AGENT_STOPPED,
  AGENT_TOO_OLD,
  agentUnavailableDetail,
} from "../src/agent-status";

describe("agentUnavailableDetail", () => {
  test("a missing host registration asks to set this computer up", () => {
    expect(
      agentUnavailableDetail({
        error: "Specified native messaging host not found.",
        everConnected: false,
      }),
    ).toBe(AGENT_NOT_SET_UP);
  });

  test("a host that refuses this extension's origin is an old agent", () => {
    expect(
      agentUnavailableDetail({
        error: "Access to the specified native messaging host is forbidden.",
        everConnected: false,
      }),
    ).toBe(AGENT_TOO_OLD);
  });

  test("a host that never accepts the profile is stopped or too old", () => {
    for (const error of [
      "Native host has exited.",
      "Opengeni agent did not accept this browser profile",
    ]) {
      expect(agentUnavailableDetail({ error, everConnected: false })).toBe(AGENT_NOT_ACCEPTING);
    }
  });

  test("losing an agent that was connected says it stopped", () => {
    expect(agentUnavailableDetail({ error: "Native host has exited.", everConnected: true })).toBe(
      AGENT_STOPPED,
    );
  });

  test("no error yet asks to start the agent", () => {
    expect(agentUnavailableDetail(null)).toBe(AGENT_START);
  });
});
