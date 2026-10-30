import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  SESSION_UNATTENDED_METADATA_KEY,
} from "@opengeni/contracts";
import {
  firstPartyToolsForAttendance,
  sessionIsUnattended,
} from "../src/activities/agent-turn/unattended";

describe("unattended turn tools", () => {
  test("a turn is unattended only when its session was created so", () => {
    expect(sessionIsUnattended({ metadata: {} })).toBe(false);
    expect(sessionIsUnattended({ metadata: { [SESSION_UNATTENDED_METADATA_KEY]: "yes" } })).toBe(
      false,
    );
    expect(sessionIsUnattended({ metadata: { [SESSION_UNATTENDED_METADATA_KEY]: true } })).toBe(
      true,
    );
  });

  test("an unattended turn has no tool that waits for a person; an attended one is unchanged", () => {
    const tools = [...DEFAULT_FIRST_PARTY_MCP_TOOLS];
    expect(tools).toContain("interaction_request_human");
    expect(firstPartyToolsForAttendance(tools, false)).toBe(tools);
    expect(firstPartyToolsForAttendance(tools, true)).toEqual(
      tools.filter((tool) => tool !== "interaction_request_human"),
    );
  });
});
