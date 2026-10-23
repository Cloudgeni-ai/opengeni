/**
 * The transcript as a person reads it: turns of one speaker, each with its
 * time, the line playing now highlighted. A speaker's name opens "Who is
 * this?" (someone from the people directory, or a new name); a turn's ⋯ menu
 * moves it to another speaker or corrects its words.
 */
import { useId, useMemo, useState } from "react";
import {
  CheckIcon,
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

/** "Who is Speaker 2?": pick a person, add a new name, or clear it. */
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
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, 12),
    [people],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 min-w-56">
        <DropdownMenuLabel>Who is {displayName}?</DropdownMenuLabel>
        {sorted.map((person) => (
          <DropdownMenuItem
            key={person.id}
            onSelect={() =>
              void withToast("Couldn't name this speaker", () =>
                actions.nameSpeaker(label, { personId: person.id }),
              )
            }
          >
            <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
            {current?.personId === person.id ? (
              <CheckIcon aria-hidden="true" className="text-brand" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {sorted.length > 0 ? <DropdownMenuSeparator /> : null}
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
      description="They're added to your organization's people, so you can pick them in other meetings."
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
  onClose,
  actions,
}: {
  turn: TranscriptTurn | null;
  onClose: () => void;
  actions: TranscriptActions;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const formId = useId();
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
      description="Fix what the transcript got wrong. The original stays with the transcript version."
      submitLabel="Save"
      pendingLabel="Saving…"
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
          <Field key={segment.index} label={formatClock(segment.startMilliseconds)}>
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

  return (
    <>
      <ol className="grid gap-6" aria-label="Transcript">
        {turns.map((turn) => {
          const name = nameOf(turn.speakerLabel);
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
                      className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-sm leading-5 font-semibold text-fg transition-colors duration-[120ms] hover:bg-hover pointer-coarse:min-h-11"
                    >
                      <SpeakerDot slot={slots.get(turn.speakerLabel)} />
                      <span className="truncate">{name}</span>
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
                    className="rounded-[6px] px-1 text-xs leading-4 text-fg-subtle tabular-nums transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
                    aria-label={`Play from ${formatClock(turn.startMilliseconds)}`}
                  >
                    {formatClock(turn.startMilliseconds)}
                  </button>
                ) : (
                  <span className="text-xs leading-4 text-fg-subtle tabular-nums">
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
                      className={cn(
                        "rounded-[3px] transition-colors duration-[120ms] box-decoration-clone",
                        segment.index === activeSegment && "bg-brand/10",
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
      <EditTurnDialog turn={editing} onClose={() => setEditing(null)} actions={actions} />
    </>
  );
}
