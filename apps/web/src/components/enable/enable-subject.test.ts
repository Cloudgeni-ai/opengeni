import { describe, expect, test } from "bun:test";
import type { SetupConnectionState, SetupReadiness } from "@opengeni/sdk";

import {
  connectControlOf,
  enableHref,
  enableStage,
  orderedConnections,
  parseEnableSearch,
  requiredSummary,
  turnOnBlocker,
  withRequiredProviders,
} from "./enable-subject";

function connection(overrides: Partial<SetupConnectionState>): SetupConnectionState {
  return {
    provider: "github.com",
    name: "GitHub",
    mcpUrl: null,
    required: false,
    why: "x",
    connected: false,
    canConnect: true,
    catalogItemId: null,
    ...overrides,
  };
}

const optionalOnly: SetupReadiness = {
  ready: true,
  reason: null,
  connections: [
    connection({}),
    connection({ provider: "linear.app", name: "Linear", catalogItemId: "linear" }),
  ],
  missing: [],
  requiredConnected: 0,
  requiredTotal: 0,
};

describe("enable", () => {
  test("the address names one subject and a step; anything else is dropped", () => {
    expect(parseEnableSearch({ agent: "pr-reviewer", step: "check" })).toEqual({
      agent: "pr-reviewer",
      step: "check",
    });
    expect(parseEnableSearch({ app: "decision-log", step: "nope" })).toEqual({
      app: "decision-log",
    });
    expect(parseEnableSearch({ agent: "../x" })).toEqual({});
    expect(enableHref("w 1", { kind: "agent", templateKey: "triage" }, "connect")).toBe(
      "/workspaces/w%201/enable?agent=triage&step=connect",
    );
  });

  test("a setup can require more of the agent's own connections", () => {
    const strict = withRequiredProviders(optionalOnly, ["linear.app"]);
    expect(strict.ready).toBe(false);
    expect(strict.reason).toBe("Connect Linear to turn this on.");
    expect(requiredSummary(strict)).toBe("0 of 1 required connected");
    expect(orderedConnections(strict).map((entry) => entry.provider)).toEqual([
      "linear.app",
      "github.com",
    ]);
    expect(withRequiredProviders(optionalOnly, [])).toBe(optionalOnly);
    expect(requiredSummary(optionalOnly)).toBeNull();
  });

  test("each connection gets one control", () => {
    expect(connectControlOf(connection({ connected: true }))).toBe("connected");
    expect(connectControlOf(connection({ canConnect: false }))).toBe("ask-admin");
    expect(connectControlOf(connection({}))).toBe("connect");
    expect(connectControlOf(connection({ provider: "linear.app" }))).toBe("not-offered");
    expect(connectControlOf(connection({ provider: "linear.app", catalogItemId: "l" }))).toBe(
      "connect",
    );
  });

  test("Turn on says why it is off: connections first, then permission", () => {
    const base = {
      readiness: optionalOnly,
      canAdd: true,
      canEdit: true,
      added: false,
      triggerFound: true,
      subjectName: "Triage",
    };
    expect(turnOnBlocker(base)).toBeNull();
    expect(
      turnOnBlocker({ ...base, readiness: withRequiredProviders(optionalOnly, ["github.com"]) }),
    ).toBe("Connect GitHub to turn this on.");
    expect(turnOnBlocker({ ...base, canAdd: false })).toBe("Ask an admin to add Triage.");
    expect(turnOnBlocker({ ...base, added: true, canEdit: false })).toBe(
      "Needs edit access to Triage.",
    );
    expect(turnOnBlocker({ ...base, triggerFound: false })).toBe("Triage has nothing to turn on.");
    // A readiness that couldn't be read doesn't block: the server checks on Turn on.
    expect(turnOnBlocker({ ...base, readiness: null })).toBeNull();
    expect(enableStage({ readiness: null, on: false })).toBe("turn-on");
    expect(
      enableStage({ readiness: withRequiredProviders(optionalOnly, ["github.com"]), on: false }),
    ).toBe("connect");
    expect(enableStage({ readiness: optionalOnly, on: true })).toBe("on");
  });
});
