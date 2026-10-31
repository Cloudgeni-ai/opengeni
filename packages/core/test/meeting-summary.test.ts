import { expect, test } from "bun:test";

import { meetingSummaryPrompt } from "../src/domain/meeting-summary";

const id = "5f2d1c4b-0a9e-4d8c-b7f6-e5d4c3b2a190";

test("the summary prompt asks for the notes in the agreed order, with the mention contract", () => {
  const prompt = meetingSummaryPrompt({ recordingId: id, title: "Weekly  planning\n" });
  expect(prompt).toStartWith(
    `Write the notes for the meeting "Weekly planning" (meeting id ${id})`,
  );
  const order = ["one-paragraph overview", "`##` heading for each topic", "`## Decisions`"].map(
    (part) => prompt.indexOf(part),
  );
  order.push(prompt.indexOf("`## Action items`: a checklist"));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(prompt).toContain("[Display name](person:<personId>)");
  expect(prompt).toContain("[Display name](speaker:<label>)");
  expect(prompt).toContain(
    `meeting_notes_save: meetingId ${id}, the Markdown as notes, the name as title, and expectedRevision 0`,
  );
  expect(prompt).toContain("If that revision is above 0");
});

test("the notes are in the meeting's language, headings included", () => {
  // The headings are named in English for the agent; a meeting in another
  // language gets them in its own.
  expect(meetingSummaryPrompt({ recordingId: id, title: null })).toContain(
    'Write all of it in the language the meeting was held in, the headings and "None" too.',
  );
});

test("a meeting without a title is named plainly", () => {
  expect(meetingSummaryPrompt({ recordingId: id, title: "  " })).toStartWith(
    `Write the notes for this meeting (meeting id ${id})`,
  );
});

test("the notes name the meeting, in its language", () => {
  const prompt = meetingSummaryPrompt({ recordingId: id, title: null });
  expect(prompt).toContain("Name the meeting too: a title of at most eight words");
  expect(prompt).toContain("in the meeting's language");
  expect(prompt).toContain("The name is kept only if nobody named the meeting yet.");
});

test("a date or an app's guess is not passed off as the meeting's name", () => {
  for (const titleSource of ["default", "app"] as const) {
    expect(
      meetingSummaryPrompt({ recordingId: id, title: "Zoom meeting", titleSource }),
    ).toStartWith(`Write the notes for this meeting (meeting id ${id})`);
  }
  for (const titleSource of ["person", "calendar", "conversation"] as const) {
    expect(
      meetingSummaryPrompt({ recordingId: id, title: "Acme renewal", titleSource }),
    ).toStartWith(`Write the notes for the meeting "Acme renewal" (meeting id ${id})`);
  }
});
