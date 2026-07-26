// Shared session-rename logic, reused by the three rename surfaces (the session
// header title editor, the rail row context menu, and the rail row hover
// affordance). The pure helpers here are unit-tested; the `useInlineRename`
// hook wraps them with the small bit of editing state every surface needs so
// the Enter-save / Esc-cancel / blur-save / empty-or-unchanged-no-op behaviour
// lives in exactly one place.
import { useCallback, useEffect, useRef, useState } from "react";

import type { Session } from "@/types";

/** The maximum length a session title may be renamed to. */
export const SESSION_TITLE_MAX_LENGTH = 200;

/**
 * The title shown for a session: the durable agent/user-set title, falling back
 * to the initial message, then a stable placeholder. Mirrors the rail list and
 * the header so every surface reads identically.
 */
export function sessionDisplayTitle(session: Session): string {
  return session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
}

/**
 * The value the editor seeds from when entering edit mode: the raw current
 * title (or initial message) without the "Untitled session" placeholder, so the
 * user edits the real text — not the placeholder — and an empty session opens to
 * an empty field.
 */
export function renameSeedValue(session: Session): string {
  return session.title?.trim() || session.initialMessage?.trim() || "";
}

/**
 * Resolve a submitted draft against the current display title. Returns the
 * trimmed title to persist, or `null` when the edit is a no-op (empty, or
 * unchanged from what is already shown) and should simply cancel.
 */
export function resolveRenameSubmission(draft: string, display: string): string | null {
  const next = draft.trim();
  if (!next || next === display) {
    return null;
  }
  return next;
}

type RenameFn = (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;

/**
 * Persist a submitted rename draft for a session. Resolves the draft against the
 * current display title and, only when it is a real change, calls `onRename`
 * with the session's workspace/id and the trimmed title. Returns the resulting
 * session, or `null` when the submission was an empty/unchanged no-op (so the
 * caller simply cancels without a network call). This is the exact effect the
 * `useInlineRename` commit runs; extracted so the three rename surfaces share —
 * and tests can assert — the persist semantics without a DOM.
 */
export async function performRename(
  session: Session,
  draft: string,
  onRename: RenameFn,
): Promise<Session | null> {
  const next = resolveRenameSubmission(draft, sessionDisplayTitle(session));
  if (next === null) {
    return null;
  }
  return onRename(session.workspaceId, session.id, next);
}

export interface InlineRename {
  /** Whether the inline editor is currently open. */
  editing: boolean;
  /** The current draft value (controlled input value). */
  draft: string;
  /** Whether a save is in flight (commit is a no-op while saving). */
  saving: boolean;
  /** Set the draft from the input's onChange. */
  setDraft: (value: string) => void;
  /** Ref to attach to the input so it focuses + selects on open. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Open the editor, seeding from the session's current title. */
  startEditing: () => void;
  /** Persist the draft (or cancel if it is an empty/unchanged no-op). */
  commit: () => Promise<void>;
  /** Close the editor and discard the draft. */
  cancel: () => void;
}

/**
 * The shared inline-rename interaction. Owns the editing/draft/saving state and
 * the commit/cancel logic; the host renders the input (and whatever trigger
 * opens it) and wires the handlers. Used by the header editor and the rail row.
 */
export function useInlineRename(session: Session, onRename: RenameFn): InlineRename {
  const display = sessionDisplayTitle(session);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reseed the draft whenever the displayed title changes while not editing
  // (e.g. an agent or cross-client rename arrives), so opening the editor always
  // starts from the current title.
  useEffect(() => {
    if (!editing) {
      setDraft(display);
    }
  }, [display, editing]);

  const startEditing = useCallback(() => {
    setDraft(renameSeedValue(session));
    setEditing(true);
    // Focus + select once the input mounts.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [session]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(display);
  }, [display]);

  const commit = useCallback(async () => {
    if (saving) {
      return;
    }
    const next = resolveRenameSubmission(draft, display);
    setEditing(false);
    if (next === null) {
      return;
    }
    setSaving(true);
    try {
      // Same resolve-and-persist as performRename; the draft is already
      // resolved here so we skip straight to the call.
      await onRename(session.workspaceId, session.id, next);
    } finally {
      setSaving(false);
    }
  }, [saving, draft, display, onRename, session.workspaceId, session.id]);

  return { editing, draft, saving, setDraft, inputRef, startEditing, commit, cancel };
}
