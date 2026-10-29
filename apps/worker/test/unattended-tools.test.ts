import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  SESSION_UNATTENDED_METADATA_KEY,
} from "@opengeni/contracts";
import {
  firstPartyToolsForAttendance,
  sessionForAttempt,
  sessionStartedUnattended,
  sessionUnattendedNow,
} from "../src/activities/agent-turn/unattended";

describe("unattended turn tools", () => {
  test("what the model is told follows how the chat started, not its current setting", () => {
    const started = { metadata: { [SESSION_UNATTENDED_METADATA_KEY]: true } };
    expect(sessionStartedUnattended({ metadata: {} })).toBe(false);
    expect(sessionStartedUnattended(started)).toBe(true);
    // Switching a chat later changes only call-time behaviour.
    expect(sessionStartedUnattended({ ...started, unattended: false } as never)).toBe(true);
    expect(sessionStartedUnattended({ metadata: {}, unattended: true } as never)).toBe(false);
  });

  test("call-time refusals follow the chat's current setting", () => {
    expect(sessionUnattendedNow({})).toBe(false);
    expect(sessionUnattendedNow({ unattended: false })).toBe(false);
    expect(sessionUnattendedNow({ unattended: true })).toBe(true);
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
