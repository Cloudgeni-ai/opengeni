/**
 * A meeting's notes, above its transcript: the written-up notes (summary,
 * decisions, action items) shown as Markdown with Edit, and the notepad
 * people jot into while the meeting is recorded, which saves as they type.
 *
 * While the meeting is being recorded the notepad comes first; afterwards
 * the notes do. Notes an agent wrote say so and link to its chat.
 */
import { useOpenGeniText } from "../messages/runtime";
import { useEffect, useId, useRef, useState } from "react";
import { BotIcon, LoaderCircleIcon, PencilIcon } from "lucide-react";
import { toast } from "sonner";
import type { RecordingNote } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { Markdown } from "../components/markdown";
import { useRecordingNotes, type RecordingsClientOverride } from "../recordings";
import { Button } from "../ui/button";
import { DetailSection } from "../ui/detail-sheet";
import { TextArea } from "../ui/field";
import { Notice } from "../ui/notice";
import { formatAbsoluteTime } from "../ui/relative-time";
import { Skeleton } from "../ui/skeleton";

/** How long typing pauses before the notepad saves. */
export const NOTEPAD_SAVE_DELAY_MS = 800;

function isNotesChanged(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 409 &&
    error.details?.code === "notes_changed"
  );
}

function errorText(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function MeetingNotes({
  recordingId,
  recording: override,
  capturing,
  onOpenChat,
}: {
  recordingId: string;
  recording: RecordingsClientOverride;
  /** The meeting is being recorded now, so the notepad comes first. */
  capturing: boolean;
  /** Opens the chat whose agent wrote the notes. */
  onOpenChat?: ((sessionId: string) => void) | undefined;
}) {
  const msg = useOpenGeniText();
  const notes = useRecordingNotes(recordingId, override);
  const [editing, setEditing] = useState(false);

  if (notes.loading && !notes.notes && !notes.notepad) {
    return (
      <DetailSection title={msg("meetings.notes.title")}>
        <div aria-busy="true" className="grid gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </DetailSection>
    );
  }

  const written = (
    <WrittenNotes
      note={notes.notes}
      editing={editing}
      onEdit={() => setEditing(true)}
      onDone={() => setEditing(false)}
      save={(body) => notes.save("notes", body)}
      refresh={notes.refresh}
      onOpenChat={onOpenChat}
    />
  );
  const notepad = (
    <Notepad
      note={notes.notepad}
      prominent={capturing}
      save={(body) => notes.save("notepad", body)}
    />
  );

  return (
    <DetailSection
      title={msg("meetings.notes.title")}
      action={
        notes.notes && !editing ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            className="pointer-coarse:h-11"
          >
            <PencilIcon aria-hidden="true" />
            {msg("meetings.notes.edit")}
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-6">
        {capturing ? (
          <>
            {notepad}
            {notes.notes ? written : null}
          </>
        ) : (
          <>
            {written}
            {notepad}
          </>
        )}
      </div>
    </DetailSection>
  );
}

function WrittenNotes({
  note,
  editing,
  onEdit,
  onDone,
  save,
  refresh,
  onOpenChat,
}: {
  note: RecordingNote | null;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  save: (body: string) => Promise<RecordingNote>;
  refresh: () => Promise<void>;
  onOpenChat?: ((sessionId: string) => void) | undefined;
}) {
  const msg = useOpenGeniText();
  const [draft, setDraft] = useState(note?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const editorId = useId();

  useEffect(() => {
    // Start each edit from the notes as they are now.
    if (editing) {
      setDraft(note?.body ?? "");
      setChangedMeanwhile(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    const submit = async () => {
      setSaving(true);
      try {
        await save(draft);
        onDone();
        toast.success(msg("meetings.notes.saved"));
      } catch (error) {
        if (isNotesChanged(error)) {
          // Load theirs so a second Save replaces it knowingly.
          await refresh();
          setChangedMeanwhile(true);
        } else {
          toast.error(msg("meetings.notes.couldNotSave"), { description: errorText(error) });
        }
      } finally {
        setSaving(false);
      }
    };
    return (
      <div className="grid gap-3">
        <label htmlFor={editorId} className="sr-only">
          {msg("meetings.notes.editorLabel")}
        </label>
        <TextArea
          id={editorId}
          rows={10}
          mono
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={msg("meetings.notes.editorPlaceholder")}
          className="max-h-[60vh]"
        />
        {changedMeanwhile ? (
          <Notice tone="info">{msg("meetings.notes.changedMeanwhile")}</Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={() => void submit()}
            className="pointer-coarse:h-11"
          >
            {saving ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
            {changedMeanwhile ? msg("meetings.notes.saveAnyway") : msg("meetings.notes.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={onDone}
            className="pointer-coarse:h-11"
          >
            {msg("meetings.notes.cancel")}
          </Button>
          <span className="text-xs leading-4 text-fg-muted">
            {msg("meetings.notes.markdownHint")}
          </span>
        </div>
      </div>
    );
  }

  if (!note || !note.body.trim()) {
    return (
      <div className="grid justify-items-start gap-3">
        <p className="text-sm leading-5 text-fg-muted">{msg("meetings.notes.empty")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onEdit}
          className="pointer-coarse:h-11"
        >
          <PencilIcon aria-hidden="true" />
          {msg("meetings.notes.write")}
        </Button>
      </div>
    );
  }

  const sessionId = note.updatedBy.sessionId;
  return (
    <div className="grid gap-3">
      <Markdown className="text-sm">{note.body}</Markdown>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4 text-fg-muted">
        {sessionId ? (
          <>
            <BotIcon aria-hidden="true" className="size-3.5" />
            <span>
              {msg("meetings.notes.writtenByAgent", {
                time: formatAbsoluteTime(note.updatedAt, { text: msg }),
              })}
            </span>
            {onOpenChat ? (
              <button
                type="button"
                onClick={() => onOpenChat(sessionId)}
                className="font-medium text-fg-label underline-offset-2 hover:underline pointer-coarse:min-h-11"
              >
                {msg("meetings.notes.openChat")}
              </button>
            ) : null}
          </>
        ) : (
          <span>
            {msg("meetings.notes.edited", {
              time: formatAbsoluteTime(note.updatedAt, { text: msg }),
            })}
          </span>
        )}
      </p>
    </div>
  );
}

type NotepadStatus = "idle" | "saving" | "saved" | "failed";

function Notepad({
  note,
  prominent,
  save,
}: {
  note: RecordingNote | null;
  prominent: boolean;
  save: (body: string) => Promise<RecordingNote>;
}) {
  const msg = useOpenGeniText();
  const id = useId();
  const [draft, setDraft] = useState(note?.body ?? "");
  const [status, setStatus] = useState<NotepadStatus>("idle");
  // What the server last confirmed, and whether the reader has typed since.
  const saved = useRef(note?.body ?? "");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Text saved elsewhere arrives while nobody is typing here.
  useEffect(() => {
    const body = note?.body ?? "";
    if (!dirty.current && body !== saved.current) {
      saved.current = body;
      setDraft(body);
    }
  }, [note?.body]);

  const flush = (body: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (body === saved.current) {
      dirty.current = false;
      return;
    }
    setStatus("saving");
    void saveRef.current(body).then(
      () => {
        saved.current = body;
        dirty.current = false;
        setStatus("saved");
      },
      () => setStatus("failed"),
    );
  };

  // Leaving the page saves what was typed last.
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () => () => {
      if (timer.current) flush(latest.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm leading-5 font-medium text-fg">
          {msg("meetings.notes.notepad")}
        </label>
        <span role="status" aria-live="polite" className="text-xs leading-4 text-fg-muted">
          {status === "saving"
            ? msg("meetings.notes.notepadSaving")
            : status === "saved"
              ? msg("meetings.notes.notepadSaved")
              : status === "failed"
                ? msg("meetings.notes.notepadFailed")
                : null}
        </span>
      </div>
      <TextArea
        id={id}
        rows={prominent ? 6 : 3}
        value={draft}
        placeholder={msg("meetings.notes.notepadPlaceholder")}
        onChange={(event) => {
          const body = event.target.value;
          setDraft(body);
          dirty.current = true;
          setStatus("idle");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => flush(body), NOTEPAD_SAVE_DELAY_MS);
        }}
        onBlur={() => flush(draft)}
      />
      {status === "failed" ? (
        <button
          type="button"
          onClick={() => flush(draft)}
          className="w-fit text-xs leading-4 font-medium text-fg-label underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          {msg("meetings.notes.notepadRetry")}
        </button>
      ) : null}
    </div>
  );
}
