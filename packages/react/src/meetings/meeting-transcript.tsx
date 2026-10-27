/**
 * The transcript as a person reads it: turns of one speaker, each a soft
 * bubble under the speaker's name in their colour, with its time and the line
 * playing now highlighted. A speaker's name opens "Who is this?" (someone from
 * the people directory, or a new name); a turn's pencil corrects its words and
 * its ⋯ menu moves it to another speaker. A name recognized by voice is marked
 * suggested until someone confirms or turns it down.
 */
import { useOpenGeniText, createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  RecordingPerson,
  RecordingSpeaker,
  RecordingTrack,
  RecordingTranscriptSegment,
} from "@opengeni/contracts";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Field, FieldStack, TextArea, TextInput } from "../ui/field";
import { FormDialog } from "../ui/form-dialog";
import { cn } from "../app/lib/utils";

import {
  formatClock,
  groupTranscriptTurns,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  type TranscriptTurn,
} from "../recordings";
import { MeetingsOverlayScope } from "./overlay-scope";

const defaultText = createOpenGeniText();

/** The chart palette, one hue per voice. */
const SPEAKER_DOT: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
  6: "bg-chart-6",
};

/**
 * A voice's hue, for its name and mentions; the shared rules below mix it.
 * Set inline, so the six slots cost no stylesheet rules.
 */
export function speakerHueStyle(slot: number | undefined): CSSProperties | undefined {
  return slot !== undefined && SPEAKER_DOT[slot]
    ? ({ "--speaker-hue": `var(--color-chart-${slot})` } as CSSProperties)
    : undefined;
}

/**
 * The hue mixed toward the text colour, so it reads on both themes: darker on
 * light, lighter on dark. Light takes more of the text colour (about 5:1 or
 * better on the page and on a mention's tint); dark keeps more hue at the
 * same contrast.
 */
const SPEAKER_TEXT =
  "text-[color-mix(in_oklab,var(--speaker-hue)_50%,var(--color-fg))] dark:text-[color-mix(in_oklab,var(--speaker-hue)_62%,var(--color-fg))]";

/** A faint fill in the voice's hue, for a mention of that speaker. */
const SPEAKER_TINT = "bg-[color-mix(in_oklab,var(--speaker-hue)_14%,transparent)]";

/** The text colour of a speaker's colour slot, with {@link speakerHueStyle}; muted when there is none. */
export function speakerTextClass(slot: number | undefined): string {
  return speakerHueStyle(slot) ? SPEAKER_TEXT : "text-fg-muted";
}

/** The faint fill of a speaker's colour slot, with {@link speakerHueStyle}; the chip surface when there is none. */
export function speakerTintClass(slot: number | undefined): string {
  return speakerHueStyle(slot) ? SPEAKER_TINT : "bg-surface-2";
}

/** A turn's pencil and ⋯: shown on hover or focus of the turn, always on touch. */
const TURN_ACTION =
  "size-7 rounded-[8px] text-fg-subtle opacity-0 transition-opacity duration-[120ms] group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none pointer-coarse:size-11 pointer-coarse:opacity-100";

export function SpeakerDot({ slot, className }: { slot: number | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        SPEAKER_DOT[slot ?? 0] ?? "bg-fg-subtle",
        className,
      )}
    />
  );
}

export type TranscriptActions = {
  nameSpeaker: (
    label: string,
    name: { personId: string } | { name: string } | null,
  ) => Promise<void>;
  /** Turn down a name suggested from a voice. */
  rejectSuggestion: (label: string) => Promise<void>;
  createPerson: (displayName: string) => Promise<RecordingPerson>;
  /**
   * Name a speaker as the person reading, linked to their account so their
   * own voice can be remembered. Null when there is no signed-in member.
   */
  nameSelf: ((label: string) => Promise<void>) | null;
  /** Who is reading, to tell their own entry in the people list apart. */
  viewerSubjectId: string | null;
  moveSegment: (segmentIndex: number, label: string) => Promise<void>;
  editSegment: (segmentIndex: number, text: string | null) => Promise<void>;
  /** Null when the workspace doesn't recognize people by voice. */
  voices: VoiceActions | null;
};

/** Remembering and forgetting voices, from a named speaker's menu. */
export type VoiceActions = {
  viewerSubjectId: string;
  /** Asks first when the person is someone from outside the workspace. */
  remember: (person: RecordingPerson) => void;
  forget: (person: RecordingPerson) => Promise<void>;
};

/** The speaker's name came from their voice and nobody has confirmed it yet. */
export function speakerIsSuggested(
  label: string | null,
  speakers: readonly RecordingSpeaker[],
): RecordingSpeaker | null {
  if (!label) return null;
  const speaker = speakers.find((candidate) => candidate.label === label);
  return speaker?.source === "suggested" && speaker.personId ? speaker : null;
}

/** "92% match", from the voice similarity behind a suggestion. */
export function suggestionMatch(
  speaker: RecordingSpeaker,
  msg: OpenGeniText = defaultText,
): string | null {
  return speaker.confidence === null
    ? null
    : msg("meetings.transcript.valueMatch", {
        value: Math.round(Math.max(0, Math.min(1, speaker.confidence)) * 100),
      });
}

async function withToast(failure: string, work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    toast.error(failure, { description: error instanceof Error ? error.message : undefined });
    return false;
  }
}

/**
 * "Who is Speaker 2?": pick a person, add a new name, or clear it. People
 * already named in this meeting come first as "Same person as …", because
 * picking one joins the two voices under one name.
 */
export function SpeakerNameMenu({
  label,
  displayName,
  speakers,
  people,
  actions,
  onAddNew,
  children,
  align = "start",
  defaultOpen,
}: {
  label: string;
  displayName: string;
  speakers: readonly RecordingSpeaker[];
  people: readonly RecordingPerson[];
  actions: TranscriptActions;
  onAddNew: (label: string) => void;
  children: React.ReactNode;
  align?: "start" | "end";
  /** Open on first render, for previews. */
  defaultOpen?: boolean;
}) {
  const msg = useOpenGeniText();
  const current = speakers.find((speaker) => speaker.label === label);
  const named = speakerIsNamed(label, speakers);
  const suggested = speakerIsSuggested(label, speakers);
  const inMeeting = useMemo(() => {
    const ids = new Set(
      speakers
        .filter((speaker) => speaker.label !== label && speaker.personId)
        .map((speaker) => speaker.personId!),
    );
    return people.filter((person) => ids.has(person.id) && person.id !== current?.personId);
  }, [people, speakers, label, current?.personId]);
  const viewerSubjectId = actions.viewerSubjectId;
  const others = useMemo(
    () =>
      people
        // A suggested person is already the first choice above, and the
        // reader is "It's me".
        .filter(
          (person) =>
            !inMeeting.includes(person) &&
            !(current?.source === "suggested" && person.id === current.personId) &&
            !(viewerSubjectId && person.memberSubjectId === viewerSubjectId),
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, 12),
    [people, inMeeting, current?.source, current?.personId, viewerSubjectId],
  );
  const pick = (person: RecordingPerson) =>
    void withToast(msg("meetings.transcript.couldnTNameThisSpeaker"), () =>
      actions.nameSpeaker(label, { personId: person.id }),
    );
  const nameSelf = actions.nameSelf;
  const isSelf = Boolean(
    viewerSubjectId &&
    current?.personId &&
    people.some(
      (person) => person.id === current.personId && person.memberSubjectId === viewerSubjectId,
    ),
  );
  const selfItem =
    nameSelf && !isSelf ? (
      <DropdownMenuItem
        onSelect={() =>
          void withToast(msg("meetings.transcript.couldnTNameThisSpeaker"), () => nameSelf(label))
        }
      >
        <UserIcon aria-hidden="true" />
        {msg("meetings.transcript.itSMe")}
      </DropdownMenuItem>
    ) : null;
  const currentPerson = current?.personId
    ? (people.find((candidate) => candidate.id === current.personId) ?? null)
    : null;
  const voiceItem =
    !suggested && currentPerson && actions.voices
      ? voiceMenuItem(currentPerson, actions.voices, msg)
      : null;
  return (
    <DropdownMenu {...(defaultOpen ? { defaultOpen } : {})}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 min-w-56">
        {suggested ? (
          <>
            <DropdownMenuLabel className="grid gap-0.5">
              <span>
                {msg("meetings.transcript.isThisDisplayname", { displayName: displayName })}
              </span>
              <span className="text-xs leading-4 font-normal text-fg-muted">
                {suggestionMatch(suggested, msg)
                  ? msg("meetings.transcript.suggestedBecauseTheVoiceSounds", {
                      suggestionMatch: suggestionMatch(suggested, msg),
                    })
                  : msg("meetings.transcript.suggestedBecauseTheVoiceSounds2")}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() =>
                void withToast(msg("meetings.transcript.couldnTConfirmThisName"), () =>
                  actions.nameSpeaker(label, { personId: suggested.personId! }),
                )
              }
            >
              <CheckIcon aria-hidden="true" />
              {msg("meetings.transcript.yesItSDisplayname", { displayName: displayName })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void withToast(msg("meetings.transcript.couldnTTurnDownThis"), () =>
                  actions.rejectSuggestion(label),
                )
              }
            >
              <XIcon aria-hidden="true" />
              {msg("meetings.transcript.noLeaveUnnamed")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs leading-4 font-normal text-fg-muted">
              {msg("meetings.transcript.orPickWhoItIs")}
            </DropdownMenuLabel>
          </>
        ) : (
          <DropdownMenuLabel>
            {msg("meetings.transcript.whoIsDisplayname", { displayName: displayName })}
          </DropdownMenuLabel>
        )}
        {selfItem}
        {selfItem && inMeeting.length + others.length > 0 ? <DropdownMenuSeparator /> : null}
        {inMeeting.map((person) => (
          <DropdownMenuItem key={person.id} onSelect={() => pick(person)}>
            <span className="min-w-0 flex-1 truncate">
              {msg("meetings.transcript.samePersonAsDisplayname", {
                displayName: person.displayName,
              })}
            </span>
          </DropdownMenuItem>
        ))}
        {inMeeting.length > 0 && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.map((person) => (
          <DropdownMenuItem key={person.id} onSelect={() => pick(person)}>
            <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
            {current?.personId === person.id && !suggested ? (
              <CheckIcon aria-hidden="true" className="text-brand" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {inMeeting.length + others.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => onAddNew(label)}>
          <UserPlusIcon aria-hidden="true" />
          {msg("meetings.transcript.someoneNew")}
        </DropdownMenuItem>
        {named && !suggested ? (
          <DropdownMenuItem
            onSelect={() =>
              void withToast(msg("meetings.transcript.couldnTClearThisName"), () =>
                actions.nameSpeaker(label, null),
              )
            }
          >
            <XIcon aria-hidden="true" />
            {msg("meetings.transcript.removeName")}
          </DropdownMenuItem>
        ) : null}
        {voiceItem ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs leading-4 font-normal text-fg-muted">
              {msg("meetings.transcript.usedToSuggestNamesIn")}
            </DropdownMenuLabel>
            {voiceItem}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Remember my voice", "Remember Maja's voice…" or "Forget …": members only
 * decide for themselves, so another member's voice offers nothing here.
 */
function voiceMenuItem(
  person: RecordingPerson,
  voices: VoiceActions,
  msg: OpenGeniText = defaultText,
): React.ReactNode {
  const self = person.memberSubjectId === voices.viewerSubjectId;
  if (person.memberSubjectId && !self) return null;
  if (person.voice) {
    return (
      <DropdownMenuItem
        onSelect={() =>
          void withToast(msg("meetings.transcript.couldnTForgetThisVoice"), () =>
            voices.forget(person),
          )
        }
      >
        <AudioLinesIcon aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {self
            ? msg("meetings.transcript.forgetMyVoice")
            : msg("meetings.transcript.forgetDisplaynameSVoice", {
                displayName: person.displayName,
              })}
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem onSelect={() => voices.remember(person)}>
      <AudioLinesIcon aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {self
          ? msg("meetings.transcript.rememberMyVoice")
          : msg("meetings.transcript.rememberDisplaynameSVoice", {
              displayName: person.displayName,
            })}
      </span>
    </DropdownMenuItem>
  );
}

/** "Name this speaker": adds them to the people directory and names the voice. */
export function NewSpeakerNameDialog({
  label,
  displayName,
  actions,
  onClose,
}: {
  label: string | null;
  displayName: string;
  actions: TranscriptActions;
  onClose: () => void;
}) {
  const msg = useOpenGeniText();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={label !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setName("");
          setError(null);
        }
      }}
      title={msg("meetings.transcript.whoIsDisplayname", { displayName: displayName })}
      description={msg("meetings.transcript.theNameIsAddedTo")}
      submitLabel={msg("meetings.transcript.saveName")}
      pendingLabel={msg("meetings.transcript.saving")}
      submitDisabled={!name.trim()}
      error={error}
      onSubmit={async () => {
        if (!label || !name.trim()) return false;
        try {
          const person = await actions.createPerson(name.trim());
          await actions.nameSpeaker(label, { personId: person.id });
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : msg("meetings.transcript.couldnTSaveThisName"),
          );
          return false;
        }
        setName("");
        setError(null);
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label={msg("meetings.transcript.name")}>
          <TextInput
            value={name}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder={msg("meetings.transcript.forExampleMajaBerg")}
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}

function EditTurnDialog({
  turn,
  speakerName,
  onClose,
  actions,
}: {
  turn: TranscriptTurn | null;
  speakerName: string;
  onClose: () => void;
  actions: TranscriptActions;
}) {
  const msg = useOpenGeniText();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const formId = useId();
  const changed =
    turn?.segments.some(
      (segment) => drafts[segment.index] !== undefined && drafts[segment.index] !== segment.text,
    ) ?? false;
  return (
    <FormDialog
      open={turn !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setDrafts({});
        }
      }}
      size="lg"
      title={msg("meetings.transcript.correctTheWords")}
      description={msg("meetings.transcript.fixWhatTheTranscriptGot")}
      submitLabel={msg("meetings.transcript.save")}
      pendingLabel={msg("meetings.transcript.saving")}
      submitDisabled={!changed}
      onSubmit={async () => {
        if (!turn) return;
        const changes = turn.segments.filter(
          (segment) =>
            drafts[segment.index] !== undefined && drafts[segment.index] !== segment.text,
        );
        const ok = await withToast(
          msg("meetings.transcript.couldnTSaveTheCorrection"),
          async () => {
            for (const segment of changes) {
              const text = drafts[segment.index]!.trim();
              await actions.editSegment(segment.index, text.length > 0 ? text : null);
            }
          },
        );
        if (!ok) return false;
        setDrafts({});
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        {turn?.segments.map((segment) => (
          <Field
            key={segment.index}
            label={msg("meetings.transcript.speakernameAtFormatclock", {
              speakerName: speakerName,
              formatClock: formatClock(segment.startMilliseconds),
            })}
          >
            <TextArea
              id={`${formId}-${segment.index}`}
              rows={Math.min(8, Math.max(2, Math.ceil(segment.text.length / 80)))}
              value={drafts[segment.index] ?? segment.text}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [segment.index]: event.target.value }))
              }
            />
          </Field>
        ))}
      </FieldStack>
    </FormDialog>
  );
}

function MeetingTranscriptContent({
  segments,
  speakers,
  tracks,
  people,
  activeSegment,
  actions,
  onSeek,
}: {
  segments: readonly RecordingTranscriptSegment[];
  speakers: readonly RecordingSpeaker[];
  tracks: readonly RecordingTrack[];
  people: readonly RecordingPerson[];
  /** The segment playing now. */
  activeSegment: number | null;
  actions: TranscriptActions;
  /** Null when there is no audio to play. */
  onSeek: ((milliseconds: number) => void) | null;
}) {
  const msg = useOpenGeniText();
  const turns = useMemo(() => groupTranscriptTurns(segments), [segments]);
  const slots = useMemo(() => speakerColorSlots(segments), [segments]);
  const labels = useMemo(() => [...slots.keys()], [slots]);
  const [naming, setNaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<TranscriptTurn | null>(null);
  const nameOf = (label: string | null) => speakerDisplayName(label, speakers, tracks, msg);
  const listRef = useRef<HTMLOListElement>(null);
  // Follow playback: keep the playing line in view while the reader is
  // following it, and stop following once they scroll elsewhere.
  const previousActive = useRef<number | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeSegment === null) {
      previousActive.current = activeSegment;
      return;
    }
    const visible = (element: Element | null) => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    };
    const previous =
      previousActive.current === null
        ? null
        : list.querySelector(`[data-segment="${previousActive.current}"]`);
    const next = list.querySelector(`[data-segment="${activeSegment}"]`);
    previousActive.current = activeSegment;
    if (!next || visible(next) || (previous && !visible(previous))) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    next.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [activeSegment]);

  return (
    <>
      <ol ref={listRef} className="grid gap-6" aria-label={msg("meetings.transcript.transcript")}>
        {turns.map((turn) => {
          const name = nameOf(turn.speakerLabel);
          const unnamed = turn.speakerLabel ? !speakerIsNamed(turn.speakerLabel, speakers) : false;
          const suggested = speakerIsSuggested(turn.speakerLabel, speakers);
          const slot = turn.speakerLabel ? slots.get(turn.speakerLabel) : undefined;
          const at = formatClock(turn.startMilliseconds);
          return (
            <li
              key={turn.key}
              data-turn={turn.key}
              className="group/turn grid max-w-[72ch] min-w-0 gap-1.5"
            >
              <div className="flex min-w-0 items-center gap-2 pl-1">
                {turn.speakerLabel ? (
                  <SpeakerNameMenu
                    label={turn.speakerLabel}
                    displayName={name}
                    speakers={speakers}
                    people={people}
                    actions={actions}
                    onAddNew={setNaming}
                  >
                    <button
                      type="button"
                      aria-label={
                        unnamed
                          ? msg("meetings.transcript.nameNameThisSpeaker", { name: name })
                          : suggested
                            ? msg("meetings.transcript.nameSuggestedFromTheirVoice", { name: name })
                            : msg("meetings.transcript.nameChangeWhoThisIs", { name: name })
                      }
                      className="group/speaker -mx-1.5 flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-sm leading-5 font-semibold transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover pointer-coarse:min-h-11"
                    >
                      <span
                        data-speaker-name=""
                        className={cn("truncate", speakerTextClass(slot))}
                        style={speakerHueStyle(slot)}
                      >
                        {name}
                      </span>
                      {suggested ? (
                        <span className="shrink-0 rounded-full border border-dashed border-border-strong px-1.5 text-xs leading-4 font-normal text-fg-muted">
                          {msg("meetings.transcript.suggested")}
                        </span>
                      ) : null}
                      {unnamed ? (
                        // An unnamed speaker always shows it can be named, not only on hover.
                        <span className="flex shrink-0 items-center gap-1 text-xs leading-4 font-normal text-fg-muted group-hover/speaker:text-fg">
                          <PencilIcon aria-hidden="true" className="size-3" />
                          {msg("meetings.transcript.name")}
                        </span>
                      ) : (
                        <ChevronDownIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity duration-[120ms] group-hover/speaker:opacity-100 group-focus-visible/speaker:opacity-100 group-data-[state=open]/speaker:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
                        />
                      )}
                    </button>
                  </SpeakerNameMenu>
                ) : (
                  <span className="text-sm leading-5 font-semibold text-fg-muted">{name}</span>
                )}
                {onSeek ? (
                  <button
                    type="button"
                    onClick={() => onSeek(turn.startMilliseconds)}
                    className="rounded-[6px] px-1 text-xs leading-4 text-fg-muted tabular-nums underline-offset-2 transition-colors duration-[120ms] hover:text-fg hover:underline pointer-coarse:min-h-11"
                    aria-label={msg("meetings.transcript.playFromFormatclock", {
                      formatClock: at,
                    })}
                  >
                    {at}
                  </button>
                ) : (
                  <span className="text-xs leading-4 text-fg-muted tabular-nums">{at}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={msg("meetings.transcript.correctTheWordsOfNameAt", {
                    name: name,
                    formatClock: at,
                  })}
                  onClick={() => setEditing(turn)}
                  className={cn("ml-auto", TURN_ACTION)}
                >
                  <PencilIcon />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={msg("meetings.transcript.moreActionsForNameAt", {
                        name: name,
                        formatClock: at,
                      })}
                      className={TURN_ACTION}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    {labels.length > 1 ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <UsersIcon aria-hidden="true" />
                          {msg("meetings.transcript.changeSpeaker")}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="min-w-48">
                          {labels
                            .filter((label) => label !== turn.speakerLabel)
                            .map((label) => (
                              <DropdownMenuItem
                                key={label}
                                onSelect={() =>
                                  void withToast(
                                    msg("meetings.transcript.couldnTChangeTheSpeaker"),
                                    async () => {
                                      for (const segment of turn.segments) {
                                        await actions.moveSegment(segment.index, label);
                                      }
                                    },
                                  )
                                }
                              >
                                <SpeakerDot slot={slots.get(label)} />
                                <span className="min-w-0 flex-1 truncate">{nameOf(label)}</span>
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : null}
                    <DropdownMenuItem onSelect={() => setEditing(turn)}>
                      <PencilIcon aria-hidden="true" />
                      {msg("meetings.transcript.correctTheWords")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {/* A soft bubble, left-aligned for everyone, like a chat. */}
              <p
                data-turn-bubble=""
                className="w-fit max-w-full rounded-[14px] rounded-tl-[4px] bg-surface-2 px-3.5 py-2 text-[15px] leading-6 text-pretty text-fg"
              >
                {turn.segments.map((segment, position) => (
                  <span key={segment.index}>
                    {position > 0 ? " " : null}
                    <span
                      data-segment={segment.index}
                      className={cn(
                        "rounded-[3px] transition-colors duration-[120ms] box-decoration-clone",
                        segment.index === activeSegment && "bg-brand/15 text-fg",
                        onSeek && "cursor-pointer hover:bg-hover",
                      )}
                      onClick={onSeek ? () => onSeek(segment.startMilliseconds) : undefined}
                    >
                      {segment.text}
                    </span>
                    {segment.edited ? (
                      <span className="sr-only">{msg("meetings.transcript.corrected")}</span>
                    ) : null}
                  </span>
                ))}
              </p>
            </li>
          );
        })}
      </ol>
      <NewSpeakerNameDialog
        label={naming}
        displayName={naming ? nameOf(naming) : ""}
        actions={actions}
        onClose={() => setNaming(null)}
      />
      <EditTurnDialog
        turn={editing}
        speakerName={editing ? nameOf(editing.speakerLabel) : ""}
        onClose={() => setEditing(null)}
        actions={actions}
      />
    </>
  );
}

export function MeetingTranscript(props: ComponentProps<typeof MeetingTranscriptContent>) {
  return (
    <MeetingsOverlayScope>
      <MeetingTranscriptContent {...props} />
    </MeetingsOverlayScope>
  );
}
