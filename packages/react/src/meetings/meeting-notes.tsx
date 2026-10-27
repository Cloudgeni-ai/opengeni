/**
 * A meeting's notes: the written-up notes (summary, decisions, action items)
 * shown as Markdown with Edit, and the notepad people jot into while the
 * meeting is recorded, which saves as they type.
 *
 * The meeting page shows them as its Summary and Notepad tabs. While the
 * meeting is being recorded here they share one Notes section, notepad
 * first. Notes an agent wrote say so and link to its chat; mentions of
 * speakers and people show as chips (see ./meeting-mentions).
 */
import { useOpenGeniText } from "../messages/runtime";
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { BotIcon, CheckIcon, CopyIcon, LoaderCircleIcon, PencilIcon } from "lucide-react";
import { toast } from "sonner";
import type { RecordingNote } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { Markdown } from "../components/markdown";
import {
  useRecordingNotes,
  type RecordingsClientOverride,
  type UseRecordingNotesResult,
} from "../recordings";
import { copyTextToClipboard } from "../lib/clipboard";
import { Button } from "../ui/button";
import { DetailSection } from "../ui/detail-sheet";
import { TextArea } from "../ui/field";
import { Notice } from "../ui/notice";
import { formatAbsoluteTime } from "../ui/relative-time";
import { Skeleton } from "../ui/skeleton";
import { MeetingsOverlayScope } from "./overlay-scope";

import {
  meetingMentionLinkRenderer,
  meetingNotesForCopy,
  type MeetingMentionResolver,
} from "./meeting-mentions";

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

function MeetingNotesContent({
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
  const notes = useRecordingNotes(recordingId, override);
  return <MeetingNotesSection notes={notes} capturing={capturing} onOpenChat={onOpenChat} />;
}

/** The Notes section over notes the page already loads: notepad and written notes together. */
export function MeetingNotesSection({
  notes,
  capturing,
  onOpenChat,
  mentions,
}: {
  notes: UseRecordingNotesResult;
  /** The meeting is being recorded now, so the notepad comes first. */
  capturing: boolean;
  onOpenChat?: ((sessionId: string) => void) | undefined;
  /** Resolves speaker and person mentions in the written notes. */
  mentions?: MeetingMentionResolver | null | undefined;
}) {
  const msg = useOpenGeniText();
  const [editing, setEditing] = useState(false);

  if (notes.loading && !notes.notes && !notes.notepad) {
    return (
      <DetailSection title={msg("meetings.notes.title")}>
        <NotesSkeleton />
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
      mentions={mentions}
    />
  );
  const notepad = (
    <Notepad
      note={notes.notepad}
      rows={capturing ? 6 : 3}
      // Alone under the Notes heading while recording, it needs no second heading.
      labelHidden={capturing && !notes.notes}
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

function NotesSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * The Summary tab: the written notes as Markdown, who wrote them, Copy and
 * Edit. Mentions of speakers and people show as chips with current names.
 */
export function MeetingSummary({
  notes,
  onOpenChat,
  mentions,
}: {
  notes: UseRecordingNotesResult;
  onOpenChat?: ((sessionId: string) => void) | undefined;
  mentions: MeetingMentionResolver | null;
}) {
  const msg = useOpenGeniText();
  const [editing, setEditing] = useState(false);
  // A reload (such as after the window was hidden) never replaces an edit.
  if (notes.loading && !notes.notes && !editing) return <NotesSkeleton />;
  const note = notes.notes;
  const hasBody = Boolean(note?.body.trim());
  return (
    <div className="grid gap-4">
      {note && hasBody && !editing ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <NotesAttribution note={note} onOpenChat={onOpenChat} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <CopyNotesButton
              text={() => (mentions ? meetingNotesForCopy(note.body, mentions) : note.body)}
            />
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
          </div>
        </div>
      ) : null}
      <WrittenNotes
        note={note}
        editing={editing}
        onEdit={() => setEditing(true)}
        onDone={() => setEditing(false)}
        save={(body) => notes.save("notes", body)}
        refresh={notes.refresh}
        onOpenChat={onOpenChat}
        mentions={mentions}
        attribution={false}
      />
    </div>
  );
}

/** The Notepad tab: what people jot down, saved as they type. */
export function MeetingNotepad({ notes }: { notes: UseRecordingNotesResult }) {
  if (notes.loading && !notes.notepad) return <NotesSkeleton />;
  return (
    <Notepad
      note={notes.notepad}
      rows={10}
      labelHidden
      save={(body) => notes.save("notepad", body)}
    />
  );
}

const COPIED_MS = 1600;

/** Copies the notes, then says Copied for a moment. */
function CopyNotesButton({ text }: { text: () => string }) {
  const msg = useOpenGeniText();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() =>
        void copyTextToClipboard(text()).then((ok) => {
          if (!ok) {
            toast.error(msg("meetings.notes.couldNotCopy"));
            return;
          }
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        })
      }
      className="pointer-coarse:h-11"
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-live="polite">
        {copied ? msg("meetings.notes.copied") : msg("meetings.notes.copy")}
      </span>
    </Button>
  );
}

/** "Written by an agent · time · Open the chat", or "Edited · time". */
function NotesAttribution({
  note,
  onOpenChat,
}: {
  note: RecordingNote;
  onOpenChat?: ((sessionId: string) => void) | undefined;
}) {
  const msg = useOpenGeniText();
  const sessionId = note.updatedBy.sessionId;
  return (
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
  mentions,
  attribution = true,
}: {
  note: RecordingNote | null;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  save: (body: string) => Promise<RecordingNote>;
  refresh: () => Promise<void>;
  onOpenChat?: ((sessionId: string) => void) | undefined;
  mentions?: MeetingMentionResolver | null | undefined;
  /** Say who wrote them under the notes; the Summary tab says it in its header. */
  attribution?: boolean;
}) {
  const msg = useOpenGeniText();
  const [draft, setDraft] = useState(note?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const editorId = useId();
  const renderLink = useMemo(
    // Without a resolver, mentions read as their link text, never a dead link.
    () => meetingMentionLinkRenderer(mentions ?? (() => null)),
    [mentions],
  );

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

  return (
    <div className="grid gap-3">
      <Markdown className="text-sm" renderLink={renderLink}>
        {note.body}
      </Markdown>
      {attribution ? <NotesAttribution note={note} onOpenChat={onOpenChat} /> : null}
    </div>
  );
}

type NotepadStatus = "idle" | "saving" | "saved" | "failed";

function Notepad({
  note,
  rows,
  labelHidden = false,
  save,
}: {
  note: RecordingNote | null;
  rows: number;
  /** A heading or tab above already names it. */
  labelHidden?: boolean;
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

  const statusText = (
    <span role="status" aria-live="polite" className="text-xs leading-4 text-fg-muted">
      {status === "saving"
        ? msg("meetings.notes.notepadSaving")
        : status === "saved"
          ? msg("meetings.notes.notepadSaved")
          : status === "failed"
            ? msg("meetings.notes.notepadFailed")
            : null}
    </span>
  );

  return (
    <div className="grid gap-2">
      {labelHidden ? (
        <label htmlFor={id} className="sr-only">
          {msg("meetings.notes.notepad")}
        </label>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={id} className="text-sm leading-5 font-medium text-fg">
            {msg("meetings.notes.notepad")}
          </label>
          {statusText}
        </div>
      )}
      <TextArea
        id={id}
        rows={rows}
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
      {labelHidden ? <div className="flex min-h-4 justify-end">{statusText}</div> : null}
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

export function MeetingNotes(props: ComponentProps<typeof MeetingNotesContent>) {
  return (
    <MeetingsOverlayScope>
      <MeetingNotesContent {...props} />
    </MeetingsOverlayScope>
  );
}
