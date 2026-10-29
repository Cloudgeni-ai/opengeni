import { describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS } from "@opengeni/contracts";
import {
  firstPartyToolsForAttendance,
  sessionForAttempt,
  sessionIsUnattended,
} from "../src/activities/agent-turn/unattended";

describe("unattended turn tools", () => {
  test("a turn is unattended only when its session reads so", () => {
    expect(sessionIsUnattended({})).toBe(false);
    expect(sessionIsUnattended({ unattended: false })).toBe(false);
    expect(sessionIsUnattended({ unattended: true })).toBe(true);
  });

  test("a person's answer resumes its turn attended; other attempts keep the setting", () => {
    const unattended = { id: "s", unattended: true };
    const attended = { id: "s", unattended: false };
    expect(sessionForAttempt(unattended, true)).toEqual({ id: "s", unattended: false });
    expect(sessionForAttempt(unattended, false)).toBe(unattended);
    expect(sessionForAttempt(attended, true)).toBe(attended);
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
