/**
 * The transcript as a person reads it: turns of one speaker, each with its
 * time, the line playing now highlighted. A speaker's name opens "Who is
 * this?" (someone from the people directory, or a new name); a turn's ⋯ menu
 * moves it to another speaker or corrects its words.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
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

import { Button } from "@opengeni/react/ui/button";
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
} from "@opengeni/react/ui/dropdown-menu";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { cn } from "@opengeni/react/app/lib/utils";

import {
  formatClock,
  groupTranscriptTurns,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  type TranscriptTurn,
} from "./meeting-model";

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
  createPerson: (displayName: string) => Promise<RecordingPerson>;
  moveSegment: (segmentIndex: number, label: string) => Promise<void>;
  editSegment: (segmentIndex: number, text: string | null) => Promise<void>;
};

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
}: {
  label: string;
  displayName: string;
  speakers: readonly RecordingSpeaker[];
  people: readonly RecordingPerson[];
  actions: TranscriptActions;
  onAddNew: (label: string) => void;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  const current = speakers.find((speaker) => speaker.label === label);
  const named = speakerIsNamed(label, speakers);
  const inMeeting = useMemo(() => {
    const ids = new Set(
      speakers
        .filter((speaker) => speaker.label !== label && speaker.personId)
        .map((speaker) => speaker.personId!),
    );
    return people.filter((person) => ids.has(person.id) && person.id !== current?.personId);
  }, [people, speakers, label, current?.personId]);
  const others = useMemo(
    () =>
      people
        .filter((person) => !inMeeting.includes(person))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, 12),
    [people, inMeeting],
  );
  const pick = (person: RecordingPerson) =>
    void withToast("Couldn't name this speaker", () =>
      actions.nameSpeaker(label, { personId: person.id }),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 min-w-56">
        <DropdownMenuLabel>Who is {displayName}?</DropdownMenuLabel>
        {inMeeting.map((person) => (
          <DropdownMenuItem key={person.id} onSelect={() => pick(person)}>
            <span className="min-w-0 flex-1 truncate">Same person as {person.displayName}</span>
          </DropdownMenuItem>
        ))}
        {inMeeting.length > 0 && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.map((person) => (
          <DropdownMenuItem key={person.id} onSelect={() => pick(person)}>
            <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
            {current?.personId === person.id ? (
              <CheckIcon aria-hidden="true" className="text-brand" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {inMeeting.length + others.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => onAddNew(label)}>
          <UserPlusIcon aria-hidden="true" />
          Someone new…
        </DropdownMenuItem>
        {named ? (
          <DropdownMenuItem
            onSelect={() =>
              void withToast("Couldn't clear this name", () => actions.nameSpeaker(label, null))
            }
          >
            <XIcon aria-hidden="true" />
            Remove name
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
                        unnamed ? `${name}, name this speaker` : `${name}, change who this is`
                      }
                      className="group/speaker -mx-1.5 flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-sm leading-5 font-semibold text-fg transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover pointer-coarse:min-h-11"
                    >
                      <SpeakerDot slot={slots.get(turn.speakerLabel)} />
                      <span
                        className={cn(
                          "truncate",
                          unnamed &&
                            "underline decoration-fg-subtle decoration-dotted underline-offset-4",
                        )}
                      >
                        {name}
                      </span>
                      <ChevronDownIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity duration-[120ms] group-hover/speaker:opacity-100 group-focus-visible/speaker:opacity-100 group-data-[state=open]/speaker:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
                      />
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
