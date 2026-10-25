/**
 * The transcript as a person reads it: turns of one speaker, each with its
 * time, the line playing now highlighted. A speaker's name opens "Who is
 * this?" (someone from the people directory, or a new name); a turn's ⋯ menu
 * moves it to another speaker or corrects its words. A name recognized by
 * voice is marked suggested until someone confirms or turns it down.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
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

/** The chart palette, one hue per voice. Text stays in fg; only the dot carries color. */
const SPEAKER_DOT: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
  6: "bg-chart-6",
};

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
export function suggestionMatch(speaker: RecordingSpeaker): string | null {
  return speaker.confidence === null
    ? null
    : `${Math.round(Math.max(0, Math.min(1, speaker.confidence)) * 100)}% match`;
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
    void withToast("Couldn't name this speaker", () =>
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
        onSelect={() => void withToast("Couldn't name this speaker", () => nameSelf(label))}
      >
        <UserIcon aria-hidden="true" />
        It's me
      </DropdownMenuItem>
    ) : null;
  const currentPerson = current?.personId
    ? (people.find((candidate) => candidate.id === current.personId) ?? null)
    : null;
  const voiceItem =
    !suggested && currentPerson && actions.voices
      ? voiceMenuItem(currentPerson, actions.voices)
      : null;
  return (
    <DropdownMenu {...(defaultOpen ? { defaultOpen } : {})}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 min-w-56">
        {suggested ? (
          <>
            <DropdownMenuLabel className="grid gap-0.5">
              <span>Is this {displayName}?</span>
              <span className="text-xs leading-4 font-normal text-fg-muted">
                Suggested because the voice sounds like theirs
                {suggestionMatch(suggested) ? ` (${suggestionMatch(suggested)})` : ""}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() =>
                void withToast("Couldn't confirm this name", () =>
                  actions.nameSpeaker(label, { personId: suggested.personId! }),
                )
              }
            >
              <CheckIcon aria-hidden="true" />
              Yes, it's {displayName}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void withToast("Couldn't turn down this name", () =>
                  actions.rejectSuggestion(label),
                )
              }
            >
              <XIcon aria-hidden="true" />
              No, leave unnamed
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs leading-4 font-normal text-fg-muted">
              Or pick who it is
            </DropdownMenuLabel>
          </>
        ) : (
          <DropdownMenuLabel>Who is {displayName}?</DropdownMenuLabel>
        )}
        {selfItem}
        {selfItem && inMeeting.length + others.length > 0 ? <DropdownMenuSeparator /> : null}
        {inMeeting.map((person) => (
          <DropdownMenuItem key={person.id} onSelect={() => pick(person)}>
            <span className="min-w-0 flex-1 truncate">Same person as {person.displayName}</span>
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
          Someone new…
        </DropdownMenuItem>
        {named && !suggested ? (
          <DropdownMenuItem
            onSelect={() =>
              void withToast("Couldn't clear this name", () => actions.nameSpeaker(label, null))
            }
          >
            <XIcon aria-hidden="true" />
            Remove name
          </DropdownMenuItem>
        ) : null}
        {voiceItem ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs leading-4 font-normal text-fg-muted">
              Used to suggest names in later meetings
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
function voiceMenuItem(person: RecordingPerson, voices: VoiceActions): React.ReactNode {
  const self = person.memberSubjectId === voices.viewerSubjectId;
  if (person.memberSubjectId && !self) return null;
  if (person.voice) {
    return (
      <DropdownMenuItem
        onSelect={() => void withToast("Couldn't forget this voice", () => voices.forget(person))}
      >
        <AudioLinesIcon aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {self ? "Forget my voice" : `Forget ${person.displayName}'s voice`}
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem onSelect={() => voices.remember(person)}>
      <AudioLinesIcon aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {self ? "Remember my voice" : `Remember ${person.displayName}'s voice…`}
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
      title={`Who is ${displayName}?`}
      description="The name is added to the people list your organization shares, so anyone can pick it in later meetings."
      submitLabel="Save name"
      pendingLabel="Saving…"
      submitDisabled={!name.trim()}
      error={error}
      onSubmit={async () => {
        if (!label || !name.trim()) return false;
        try {
          const person = await actions.createPerson(name.trim());
          await actions.nameSpeaker(label, { personId: person.id });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Couldn't save this name.");
          return false;
        }
        setName("");
        setError(null);
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label="Name">
          <TextInput
            value={name}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder="For example, Maja Berg"
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
      title="Correct the words"
      description="Fix what the transcript got wrong. Everyone sees your correction in this version; the model's original words are kept, and clearing a line brings them back."
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!changed}
      onSubmit={async () => {
        if (!turn) return;
        const changes = turn.segments.filter(
          (segment) =>
            drafts[segment.index] !== undefined && drafts[segment.index] !== segment.text,
        );
        const ok = await withToast("Couldn't save the correction", async () => {
          for (const segment of changes) {
            const text = drafts[segment.index]!.trim();
            await actions.editSegment(segment.index, text.length > 0 ? text : null);
          }
        });
        if (!ok) return false;
        setDrafts({});
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        {turn?.segments.map((segment) => (
          <Field
            key={segment.index}
            label={`${speakerName} at ${formatClock(segment.startMilliseconds)}`}
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

export function MeetingTranscript({
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
  const turns = useMemo(() => groupTranscriptTurns(segments), [segments]);
  const slots = useMemo(() => speakerColorSlots(segments), [segments]);
  const labels = useMemo(() => [...slots.keys()], [slots]);
  const [naming, setNaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<TranscriptTurn | null>(null);
  const nameOf = (label: string | null) => speakerDisplayName(label, speakers, tracks);
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
      <ol ref={listRef} className="grid gap-6" aria-label="Transcript">
        {turns.map((turn) => {
          const name = nameOf(turn.speakerLabel);
          const unnamed = turn.speakerLabel ? !speakerIsNamed(turn.speakerLabel, speakers) : false;
          const suggested = speakerIsSuggested(turn.speakerLabel, speakers);
          const active = turn.segments.some((segment) => segment.index === activeSegment);
          return (
            <li key={turn.key} className="group/turn grid min-w-0 gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
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
                          ? `${name}, name this speaker`
                          : suggested
                            ? `${name}, suggested from their voice. Confirm or correct`
                            : `${name}, change who this is`
                      }
                      className="group/speaker -mx-1.5 flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-sm leading-5 font-semibold text-fg transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover pointer-coarse:min-h-11"
                    >
                      <SpeakerDot slot={slots.get(turn.speakerLabel)} />
                      <span className={cn("truncate", unnamed && "text-fg-label")}>{name}</span>
                      {suggested ? (
                        <span className="shrink-0 rounded-full border border-dashed border-border-strong px-1.5 text-xs leading-4 font-normal text-fg-muted">
                          Suggested
                        </span>
                      ) : null}
                      {unnamed ? (
                        // An unnamed speaker always shows it can be named, not only on hover.
                        <span className="flex shrink-0 items-center gap-1 text-xs leading-4 font-normal text-fg-muted group-hover/speaker:text-fg">
                          <PencilIcon aria-hidden="true" className="size-3" />
                          Name
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
                  <span className="flex items-center gap-2 text-sm leading-5 font-semibold text-fg-muted">
                    <SpeakerDot slot={undefined} />
                    {name}
                  </span>
                )}
                {onSeek ? (
                  <button
                    type="button"
                    onClick={() => onSeek(turn.startMilliseconds)}
                    className="rounded-[6px] px-1 text-xs leading-4 text-fg-muted tabular-nums underline-offset-2 transition-colors duration-[120ms] hover:text-fg hover:underline pointer-coarse:min-h-11"
                    aria-label={`Play from ${formatClock(turn.startMilliseconds)}`}
                  >
                    {formatClock(turn.startMilliseconds)}
                  </button>
                ) : (
                  <span className="text-xs leading-4 text-fg-muted tabular-nums">
                    {formatClock(turn.startMilliseconds)}
                  </span>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More actions for ${name} at ${formatClock(turn.startMilliseconds)}`}
                      className="ml-auto size-7 rounded-[8px] text-fg-subtle opacity-0 group-hover/turn:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    {labels.length > 1 ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <UsersIcon aria-hidden="true" />
                          Change speaker
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="min-w-48">
                          {labels
                            .filter((label) => label !== turn.speakerLabel)
                            .map((label) => (
                              <DropdownMenuItem
                                key={label}
                                onSelect={() =>
                                  void withToast("Couldn't change the speaker", async () => {
                                    for (const segment of turn.segments) {
                                      await actions.moveSegment(segment.index, label);
                                    }
                                  })
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
                      Correct the words
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p
                className={cn(
                  "max-w-[72ch] text-[15px] leading-6 text-pretty text-fg",
                  active && "text-fg",
                )}
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
                    {segment.edited ? <span className="sr-only"> (corrected)</span> : null}
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
