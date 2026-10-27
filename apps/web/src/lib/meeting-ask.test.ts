import { describe, expect, test } from "bun:test";

import { meetingQuestionMessage, meetingQuestionVisibility } from "./meeting-ask";

const ID = "5f2d1c4b-0a9e-4d8c-b7f6-e5d4c3b2a190";

describe("meetingQuestionMessage", () => {
  test("puts the question first and attaches the exact meeting for meeting_read", () => {
    const message = meetingQuestionMessage("  What did we decide on pricing?  ", {
      id: ID,
      title: "Weekly product sync",
    });
    expect(message.startsWith("What did we decide on pricing?\n\n")).toBe(true);
    expect(message).toContain("“Weekly product sync”");
    expect(message).toContain(`meeting id ${ID}`);
    expect(message).toContain("meeting_read");
  });

  test("still names the meeting by id when its title is unknown", () => {
    const message = meetingQuestionMessage("Who owns the follow-up?", { id: ID, title: null });
    expect(message).toBe(
      `Who owns the follow-up?\n\nAbout meeting ${ID}. Read it with meeting_read.`,
    );
  });
});

describe("meetingQuestionVisibility", () => {
  test("a private meeting's question starts a private chat", () => {
    expect(meetingQuestionVisibility({ visibility: "private" })).toBe("private");
  });

  test("a meeting that could not be read also starts a private chat", () => {
    expect(meetingQuestionVisibility(null)).toBe("private");
  });

  test("a workspace meeting keeps the workspace's usual chat visibility", () => {
    expect(meetingQuestionVisibility({ visibility: "workspace" })).toBeUndefined();
  });
});
