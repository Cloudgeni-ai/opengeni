import { expect, test } from "bun:test";
import { ArchivedSessionImportEvent } from "@opengeni/contracts";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import {
  archivedImportTranscript,
  archivedTranscriptEvents,
  ARCHIVED_FILE_ID,
} from "./fixtures/archived-transcript";

test("a realistic imported transcript uses the unchanged canonical timeline projection", () => {
  const wireTranscript = JSON.parse(JSON.stringify(archivedImportTranscript));
  const accepted = wireTranscript.map((event: unknown) => ArchivedSessionImportEvent.parse(event));
  expect(accepted).toEqual(archivedImportTranscript);
  const events = archivedTranscriptEvents();
  const before = structuredClone(events);
  const items = buildTimeline(events);
  expect(events).toEqual(before);
  expect(items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual([
    "Summarize the attached migration plan.",
    "Will users still see their past chats? 日本語も保持してください。",
  ]);
  expect(items.find((item) => item.kind === "user-message")).toMatchObject({
    resources: [{ kind: "file", fileId: ARCHIVED_FILE_ID }],
    occurredAt: "2024-03-01T08:00:00.000Z",
  });
  expect(items.find((item) => item.kind === "tool-call")).toMatchObject({
    name: "read_migration_plan",
    callId: "call-read-plan",
    status: "complete",
    arguments: { fileId: ARCHIVED_FILE_ID },
    output: {
      milestones: ["Re-upload files", "Import past conversations", "Switch the session proxy"],
      owner: "Support team",
    },
  });
  const messages = items.filter((item) => item.kind === "agent-message");
  expect(messages).toHaveLength(3);
  expect(messages.every((item) => !item.streaming)).toBe(true);
  expect(messages[1]).toMatchObject({
    phase: "final_answer",
    occurredAt: "2024-03-01T08:00:07.000Z",
  });
  expect(messages[1]!.text).toContain(`artifact:${ARCHIVED_FILE_ID}`);
  expect(messages[2]!.text).toContain("日本語もそのまま残ります。");
  // The normal timeline suppresses goal.completed landmarks (the goal tool owns
  // them). Imports preserve that same behavior rather than adding a new renderer.
  expect(items.filter((item) => item.kind === "goal").map((item) => item.action)).toEqual(["set"]);
  // Replayed/streamed normal envelopes and imported envelopes group identically.
  expect(
    groupTimeline(buildTimeline(JSON.parse(JSON.stringify(events))), { readableTurns: true }),
  ).toEqual(groupTimeline(items, { readableTurns: true }));
});
