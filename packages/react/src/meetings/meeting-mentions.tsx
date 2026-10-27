/**
 * Mentions in a meeting's written notes. The notes are Markdown, and an agent
 * (or a person) names someone with a link of exactly one of two forms:
 *
 * - `[Display name](speaker:<speakerLabel>)`: a voice in this meeting, such
 *   as `speaker:speaker_0` or `speaker:track-0`.
 * - `[Display name](person:<personId>)`: someone in the people directory.
 *
 * Each shows as a small chip with the current name, so renaming a speaker or
 * a person updates the notes without rewriting them. A label or id this
 * meeting doesn't know shows the link text as plain text, never a link.
 */
import type { ReactNode } from "react";
import type { RecordingPerson, RecordingSpeaker, RecordingTrack } from "@opengeni/contracts";

import type { OpenGeniLinkRenderer } from "../components/open-geni-links";
import { createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { speakerDisplayName } from "../recordings";
import { cn } from "../app/lib/utils";

import {
  SpeakerDot,
  speakerHueStyle,
  speakerTextClass,
  speakerTintClass,
} from "./meeting-transcript";

const defaultText = createOpenGeniText();

export type MeetingMention =
  | { kind: "speaker"; label: string }
  | { kind: "person"; personId: string };

/** Who a mention names now: the current name and, for a voice, its colour slot. */
export type ResolvedMeetingMention = { name: string; slot: number | undefined };

export type MeetingMentionResolver = (mention: MeetingMention) => ResolvedMeetingMention | null;

const MENTION_HREF = /^(speaker|person):(\S+)$/u;

/** The mention a link points at, or null when it is any other link. */
export function parseMeetingMention(href: string | null | undefined): MeetingMention | null {
  const match = MENTION_HREF.exec(href ?? "");
  if (!match) return null;
  let value = match[2]!;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not percent-encoded after all; keep it as written.
  }
  return match[1] === "speaker"
    ? { kind: "speaker", label: value }
    : { kind: "person", personId: value };
}

/**
 * Resolves mentions against this meeting: a speaker label it has (named or
 * heard in the transcript), or a person in the directory or named here.
 */
export function meetingMentionResolver({
  speakers,
  tracks,
  people,
  slots,
  msg = defaultText,
}: {
  speakers: readonly RecordingSpeaker[];
  tracks: readonly RecordingTrack[];
  people: readonly RecordingPerson[];
  /** The transcript's colour slot per speaker label. */
  slots: ReadonlyMap<string, number>;
  msg?: OpenGeniText;
}): MeetingMentionResolver {
  return (mention) => {
    if (mention.kind === "speaker") {
      const known =
        slots.has(mention.label) || speakers.some((speaker) => speaker.label === mention.label);
      if (!known) return null;
      return {
        name: speakerDisplayName(mention.label, speakers, tracks, msg),
        slot: slots.get(mention.label),
      };
    }
    // A person who spoke here takes that voice's colour.
    const voice = speakers.find((speaker) => speaker.personId === mention.personId);
    const slot = voice ? slots.get(voice.label) : undefined;
    const person = people.find((candidate) => candidate.id === mention.personId);
    if (person?.displayName.trim()) return { name: person.displayName, slot };
    if (voice?.name.trim()) return { name: voice.name, slot };
    return null;
  };
}

/**
 * What Copy looks at, in reading order: a fenced code block, a code span or
 * an image (each kept as written, as the page draws them literally), or a
 * mention `[text](speaker:…)` / `[text](person:…)`, with `\]`-escaped
 * brackets in the text. A code span, like on the page, never crosses a blank
 * line.
 */
const COPY_SCAN =
  /^ {0,3}(?<mark>`{3,}|~{3,})[^\n]*[\s\S]*?(?:\n {0,3}\k<mark>[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))|(?<ticks>`+)(?:(?!\n[ \t]*\n)[\s\S])*?\k<ticks>(?!`)|!\[(?:\\.|[^\\\]])*\]\([^)]*\)|\[(?<text>(?:\\.|[^\\\]])*)\]\((?<kind>speaker|person):(?<value>[^()\s]+)\)/gmu;

/** Link text as it reads: Markdown escapes removed. */
function unescapeLinkText(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/gu, "$1");
}

/**
 * The notes as Markdown with each mention turned into the plain current
 * name (or its link text when this meeting doesn't know it), for copying.
 */
export function meetingNotesForCopy(markdown: string, resolve: MeetingMentionResolver): string {
  return markdown.replace(COPY_SCAN, (...args: unknown[]) => {
    const match = args[0] as string;
    const { text, kind, value } = args.at(-1) as Partial<Record<string, string>>;
    // Code and images stay as they are.
    if (text === undefined || kind === undefined || value === undefined) return match;
    const mention = parseMeetingMention(`${kind}:${value}`);
    const resolved = mention ? resolve(mention) : null;
    return resolved ? resolved.name : unescapeLinkText(text);
  });
}

/** A mention as a small inline chip: a voice in its colour, a person plain. */
export function MeetingMentionChip({
  mention,
  name,
  slot,
}: {
  mention: MeetingMention;
  name: string;
  slot: number | undefined;
}) {
  return (
    <span
      data-mention={mention.kind}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-1.5 align-baseline text-[0.93em] leading-[1.45] font-medium whitespace-nowrap",
        slot === undefined
          ? "bg-surface-2 text-fg"
          : [speakerTintClass(slot), speakerTextClass(slot)],
      )}
      style={speakerHueStyle(slot)}
    >
      {slot !== undefined ? <SpeakerDot slot={slot} className="size-1.5" /> : null}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/**
 * Draws mention links as chips for {@link Markdown}'s `renderLink`, and any
 * mention this meeting doesn't know as its plain text. Other links fall
 * through to the default renderer.
 */
export function meetingMentionLinkRenderer(resolve: MeetingMentionResolver): OpenGeniLinkRenderer {
  return ({ href, children }): ReactNode | undefined => {
    const mention = parseMeetingMention(href);
    if (!mention) return undefined;
    const resolved = resolve(mention);
    if (!resolved) return <>{children}</>;
    return <MeetingMentionChip mention={mention} name={resolved.name} slot={resolved.slot} />;
  };
}
