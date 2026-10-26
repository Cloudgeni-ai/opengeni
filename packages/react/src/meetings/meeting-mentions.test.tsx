import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecordingPerson, RecordingSpeaker } from "@opengeni/contracts";

import {
  meetingMentionLinkRenderer,
  meetingMentionResolver,
  meetingNotesForCopy,
  parseMeetingMention,
} from "./meeting-mentions";

const TOMAS = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const MAJA = "9c8b7a6f-5e4d-4c3b-a291-807f6e5d4c3b";

function person(id: string, displayName: string): RecordingPerson {
  return {
    id,
    displayName,
    memberSubjectId: null,
    email: null,
    externalRef: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    voice: null,
  };
}

const speakers: RecordingSpeaker[] = [
  {
    label: "speaker_0",
    name: "Tomas Eriksen",
    personId: TOMAS,
    source: "confirmed",
    confidence: null,
  },
  { label: "speaker_1", name: "speaker_1", personId: null, source: null, confidence: null },
];
const slots = new Map([
  ["speaker_0", 1],
  ["speaker_1", 2],
]);
const resolve = meetingMentionResolver({
  speakers,
  tracks: [],
  people: [person(TOMAS, "Tomas Eriksen"), person(MAJA, "Maja Berg")],
  slots,
});

describe("meeting mentions", () => {
  test("only speaker: and person: links are mentions", () => {
    expect(parseMeetingMention("speaker:speaker_0")).toEqual({
      kind: "speaker",
      label: "speaker_0",
    });
    expect(parseMeetingMention(`person:${MAJA}`)).toEqual({ kind: "person", personId: MAJA });
    expect(parseMeetingMention("speaker:track%2D0")).toEqual({ kind: "speaker", label: "track-0" });
    expect(parseMeetingMention("https://example.com")).toBeNull();
    expect(parseMeetingMention("speaker:")).toBeNull();
    expect(parseMeetingMention(undefined)).toBeNull();
  });

  test("a speaker resolves to the name the transcript shows now, in its colour", () => {
    expect(resolve({ kind: "speaker", label: "speaker_0" })).toEqual({
      name: "Tomas Eriksen",
      slot: 1,
    });
    // Unnamed: the same default name as the transcript.
    expect(resolve({ kind: "speaker", label: "speaker_1" })).toEqual({
      name: "Speaker 2",
      slot: 2,
    });
    expect(resolve({ kind: "speaker", label: "speaker_9" })).toBeNull();
  });

  test("renaming a speaker or a person changes the mention without rewriting the notes", () => {
    const renamed = meetingMentionResolver({
      speakers: [
        speakers[0]!,
        {
          label: "speaker_1",
          name: "Lea Haugen",
          personId: null,
          source: "confirmed",
          confidence: null,
        },
      ],
      tracks: [],
      people: [person(TOMAS, "Tomas E."), person(MAJA, "Maja Berg")],
      slots,
    });
    expect(renamed({ kind: "speaker", label: "speaker_1" })?.name).toBe("Lea Haugen");
    expect(renamed({ kind: "person", personId: TOMAS })).toEqual({ name: "Tomas E.", slot: 1 });
  });

  test("a person resolves from the directory, taking their voice's colour when they spoke", () => {
    expect(resolve({ kind: "person", personId: TOMAS })).toEqual({
      name: "Tomas Eriksen",
      slot: 1,
    });
    expect(resolve({ kind: "person", personId: MAJA })).toEqual({
      name: "Maja Berg",
      slot: undefined,
    });
    expect(resolve({ kind: "person", personId: "unknown" })).toBeNull();
  });

  test("Copy turns mentions into plain current names, and unknown ones into their text", () => {
    const markdown = [
      "[Tomas](speaker:speaker_0) and [Someone](speaker:speaker_1) agreed.",
      `- [ ] [Maja](person:${MAJA}) follows up with [Old \\[name\\]](person:nobody)`,
      "See [the docs](https://example.com).",
    ].join("\n");
    expect(meetingNotesForCopy(markdown, resolve)).toBe(
      [
        "Tomas Eriksen and Speaker 2 agreed.",
        "- [ ] Maja Berg follows up with Old [name]",
        "See [the docs](https://example.com).",
      ].join("\n"),
    );
  });

  test("Copy keeps code and images as written, as the page draws them", () => {
    const markdown = [
      "Write `[Tomas](speaker:speaker_0)` for a mention, like [Tomas](speaker:speaker_0).",
      "```md",
      "[Maja](person:" + MAJA + ")",
      "```",
      "![avatar](speaker:speaker_0)",
      "~~~",
      "[Maja](person:" + MAJA + ")",
    ].join("\n");
    expect(meetingNotesForCopy(markdown, resolve)).toBe(
      [
        "Write `[Tomas](speaker:speaker_0)` for a mention, like Tomas Eriksen.",
        "```md",
        "[Maja](person:" + MAJA + ")",
        "```",
        "![avatar](speaker:speaker_0)",
        "~~~",
        "[Maja](person:" + MAJA + ")",
      ].join("\n"),
    );
    // An empty fence closes at once; what follows is notes again.
    expect(meetingNotesForCopy("```\n```\n[Maja](person:" + MAJA + ")", resolve)).toBe(
      "```\n```\nMaja Berg",
    );
    // A stray backtick doesn't reach past its paragraph.
    expect(
      meetingNotesForCopy("A stray ` here.\n\n[Maja](person:" + MAJA + ") and `code`.", resolve),
    ).toBe("A stray ` here.\n\nMaja Berg and `code`.");
  });

  test("a known mention draws a chip, an unknown one its plain text, other links fall through", () => {
    const render = meetingMentionLinkRenderer(resolve);
    const chip = renderToStaticMarkup(
      <>{render({ href: "speaker:speaker_0", children: "Tomas", standalone: false })}</>,
    );
    expect(chip).toContain('data-mention="speaker"');
    expect(chip).toContain("Tomas Eriksen");
    const personChip = renderToStaticMarkup(
      <>{render({ href: `person:${MAJA}`, children: "Maja", standalone: false })}</>,
    );
    expect(personChip).toContain('data-mention="person"');
    expect(personChip).toContain("Maja Berg");
    const unknown = renderToStaticMarkup(
      <>{render({ href: "speaker:speaker_9", children: "Ghost", standalone: false })}</>,
    );
    expect(unknown).toBe("Ghost");
    expect(render({ href: "https://example.com", children: "docs", standalone: false })).toBe(
      undefined,
    );
  });
});
