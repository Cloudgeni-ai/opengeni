import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  SESSION_UNATTENDED_METADATA_KEY,
} from "@opengeni/contracts";
import { UNATTENDED_SESSION_GUIDANCE } from "@opengeni/runtime";
import {
  ATTENDED_AGAIN_NOTE,
  attendanceChangeNote,
  firstPartyToolsForAttendance,
  sessionForAttempt,
  sessionStartedUnattended,
  sessionUnattendedNow,
} from "../src/activities/agent-turn/unattended";

describe("unattended turn tools", () => {
  test("a turn whose attendance differs from how the chat started says so in its input", () => {
    const startedUnattended = { [SESSION_UNATTENDED_METADATA_KEY]: true };
    // Interactive chats, and chats whose setting matches how they started, get nothing.
    expect(attendanceChangeNote({ metadata: {} })).toBeUndefined();
    expect(attendanceChangeNote({ metadata: {}, unattended: false })).toBeUndefined();
    expect(attendanceChangeNote({ metadata: startedUnattended, unattended: true })).toBeUndefined();
    // Switched to work without a person after an attended start.
    expect(attendanceChangeNote({ metadata: {}, unattended: true })).toBe(
      `[Opengeni attendance]\n${UNATTENDED_SESSION_GUIDANCE}`,
    );
    // Started unattended, and a person is now present.
    expect(attendanceChangeNote({ metadata: startedUnattended, unattended: false })).toBe(
      `[Opengeni attendance]\n${ATTENDED_AGAIN_NOTE}`,
    );
    // A person's answer resuming a turn runs it attended.
    expect(attendanceChangeNote(sessionForAttempt({ metadata: {}, unattended: true }, true))).toBe(
      undefined,
    );
  });

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
