import { describe, expect, test } from "bun:test";

import {
  AGENT_NOT_RESPONDING,
  AGENT_NOT_RUNNING,
  AGENT_NOT_SET_UP,
  AGENT_STOPPED,
  CONNECTING,
  HANDSHAKE_TIMEOUT_ERROR,
  agentOutdated,
  agentStatus,
  extensionOutdated,
} from "../src/agent-status";
import { parseAgentUnavailable, type AgentUnavailable } from "../src/protocol";

function refusal(reason: AgentUnavailable["reason"], detail: string | null = null) {
  return { type: "unavailable", reason, agentVersion: "0.1.110", detail } as const;
}

describe("agentStatus from the agent's own explanation", () => {
  const base = { error: "Opengeni agent unavailable", everConnected: false };

  test("no agent running asks to start it", () => {
    expect(agentStatus({ ...base, refusal: refusal("agent_not_running") })).toBe(AGENT_NOT_RUNNING);
  });

  test("an older agent names the agent and its version as the side to update", () => {
    const status = agentStatus({ ...base, refusal: refusal("agent_outdated") });
    expect(status).toEqual(agentOutdated("0.1.110"));
    expect(status.title).toBe("Update the Opengeni agent");
    expect(status.detail).toContain("Opengeni agent 0.1.110 on this computer is older");
  });

  test("an older extension names the extension as the side to update", () => {
    const status = agentStatus({ ...base, refusal: refusal("extension_outdated") });
    expect(status).toEqual(extensionOutdated("0.1.110"));
    expect(status.title).toBe("Update this extension");
  });

  test("another refusal shows the agent's reason", () => {
    const status = agentStatus({
      ...base,
      refusal: refusal("agent_error", "browser tab is invalid"),
    });
    expect(status.detail).toContain("(browser tab is invalid)");
  });

  test("the explanation wins over an earlier connection", () => {
    expect(
      agentStatus({ ...base, everConnected: true, refusal: refusal("agent_not_running") }),
    ).toBe(AGENT_NOT_RUNNING);
  });
});

describe("agentStatus without an explanation", () => {
  test("a missing host registration asks to set this computer up", () => {
    for (const error of [
      "Specified native messaging host not found.",
      "Failed to start native messaging host.",
    ]) {
      expect(agentStatus({ error, everConnected: false })).toBe(AGENT_NOT_SET_UP);
    }
  });

  test("a host that refuses this extension's origin is an older agent", () => {
    expect(
      agentStatus({
        error: "Access to the specified native messaging host is forbidden.",
        everConnected: false,
      }),
    ).toEqual(agentOutdated(null));
  });

  test("a host that closes silently before ever connecting is an older agent", () => {
    const status = agentStatus({ error: "Native host has exited.", everConnected: false });
    expect(status).toEqual(agentOutdated(null));
    expect(status.detail).toBe(
      "The Opengeni agent on this computer is older than this extension. Update the Opengeni app or agent on this computer, or restart it if it just updated; then this profile connects.",
    );
  });

  test("an agent that never answers is not responding", () => {
    expect(agentStatus({ error: HANDSHAKE_TIMEOUT_ERROR, everConnected: false })).toBe(
      AGENT_NOT_RESPONDING,
    );
  });

  test("losing an agent that was connected says it stopped", () => {
    expect(agentStatus({ error: "Native host has exited.", everConnected: true })).toBe(
      AGENT_STOPPED,
    );
  });

  test("no error yet is connecting", () => {
    expect(agentStatus(null)).toBe(CONNECTING);
  });
});

describe("parseAgentUnavailable", () => {
  test("reads the agent's frame", () => {
    expect(
      parseAgentUnavailable({
        type: "unavailable",
        protocolVersion: 1,
        reason: "agent_outdated",
        agentVersion: "0.1.110",
        detail: "extension protocol version is unsupported",
      }),
    ).toEqual({
      type: "unavailable",
      reason: "agent_outdated",
      agentVersion: "0.1.110",
      detail: "extension protocol version is unsupported",
    });
  });

  test("reads frames from other protocol versions and unknown reasons", () => {
    expect(
      parseAgentUnavailable({ type: "unavailable", protocolVersion: 9, reason: "new", extra: 1 }),
    ).toEqual({ type: "unavailable", reason: "agent_error", agentVersion: null, detail: null });
  });
});
