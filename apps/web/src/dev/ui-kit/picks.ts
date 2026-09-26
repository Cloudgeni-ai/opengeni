import { useSyncExternalStore } from "react";
import {
  ALTERNATIVE_IDS,
  FORK_SECTIONS,
  alternativeLetter,
  alternativeMeta,
  getSection,
  isSectionKey,
  visibleGroups,
  sectionsInGroup,
  type AlternativeId,
  type SectionKey,
} from "./sections/registry";

/**
 * Picks and notes, persisted in this browser. One store shared by every
 * component on the page (and by the mobile preview frames, through the
 * `storage` event), so a pick made anywhere shows everywhere.
 */

export const PICKS_STORAGE_KEY = "opengeni-ui-kit-picks-v1";

export interface PickState {
  picks: Partial<Record<SectionKey, AlternativeId>>;
  notes: Partial<Record<SectionKey, string>>;
}

const EMPTY_STATE: PickState = { picks: {}, notes: {} };

let cachedRaw: string | null | undefined;
let cachedState: PickState = EMPTY_STATE;
/** Used when storage is blocked, so picks still work for this tab. */
let memoryState: PickState | null = null;
const listeners = new Set<() => void>();

function parseState(raw: string | null): PickState {
  if (!raw) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as { picks?: unknown; notes?: unknown };
    const picks: PickState["picks"] = {};
    const notes: PickState["notes"] = {};
    if (value.picks && typeof value.picks === "object") {
      for (const [key, id] of Object.entries(value.picks)) {
        if (isSectionKey(key) && ALTERNATIVE_IDS.includes(id as AlternativeId)) {
          picks[key] = id as AlternativeId;
        }
      }
    }
    if (value.notes && typeof value.notes === "object") {
      for (const [key, note] of Object.entries(value.notes)) {
        if (isSectionKey(key) && typeof note === "string" && note.length > 0) notes[key] = note;
      }
    }
    return { picks, notes };
  } catch {
    return EMPTY_STATE;
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(PICKS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): PickState {
  if (memoryState) return memoryState;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedState = parseState(raw);
  }
  return cachedState;
}

function emit() {
  for (const listener of listeners) listener();
}

function writeState(next: PickState) {
  const raw = JSON.stringify({ version: 1, ...next, updatedAt: new Date().toISOString() });
  try {
    window.localStorage.setItem(PICKS_STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedState = next;
    memoryState = null;
  } catch {
    memoryState = next;
  }
  emit();
}

function onStorage(event: StorageEvent) {
  if (event.key === PICKS_STORAGE_KEY || event.key === null) emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** The whole pick state. Re-renders on any change. */
export function usePickState(): PickState {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STATE);
}

/**
 * The alternative to render for `key`: Bendik's pick, or the recommended
 * default when he hasn't picked yet. Use this in page previews.
 */
export function usePick(key: SectionKey): AlternativeId {
  const state = usePickState();
  return state.picks[key] ?? getSection(key).recommended ?? "a";
}

/** Bendik's explicit pick for `key`, or null when he hasn't picked. */
export function useExplicitPick(key: SectionKey): AlternativeId | null {
  return usePickState().picks[key] ?? null;
}

/** Pick an alternative. Pass null to clear the pick. */
export function setPick(key: SectionKey, id: AlternativeId | null) {
  const current = getSnapshot();
  const picks = { ...current.picks };
  if (id) picks[key] = id;
  else delete picks[key];
  writeState({ ...current, picks });
}

export function useNote(key: SectionKey): string {
  return usePickState().notes[key] ?? "";
}

export function setNote(key: SectionKey, note: string) {
  const current = getSnapshot();
  const notes = { ...current.notes };
  if (note.length > 0) notes[key] = note;
  else delete notes[key];
  writeState({ ...current, notes });
}

export interface PickProgress {
  picked: number;
  total: number;
}

export function pickProgress(state: PickState): PickProgress {
  return {
    picked: FORK_SECTIONS.filter((section) => state.picks[section.key]).length,
    total: FORK_SECTIONS.length,
  };
}

export function usePickProgress(): PickProgress {
  return pickProgress(usePickState());
}

function describeAlternative(key: SectionKey, id: AlternativeId): string {
  const name = alternativeMeta(key, id)?.name;
  return name ? `${alternativeLetter(id)} - ${name}` : alternativeLetter(id);
}

/** Readable text of every pick and note, for pasting back into a conversation. */
export function formatPicksForExport(state: PickState): string {
  const progress = pickProgress(state);
  const lines = [`OpenGeni UI kit - my picks (${progress.picked} of ${progress.total} picked)`];
  const unpicked: string[] = [];

  for (const group of visibleGroups()) {
    const groupLines: string[] = [];
    for (const section of sectionsInGroup(group)) {
      const note = state.notes[section.key]?.trim();
      const pick = state.picks[section.key];
      if (section.recommended) {
        if (pick) {
          const recommended = pick === section.recommended ? " (recommended)" : "";
          groupLines.push(
            `- ${section.title}: ${describeAlternative(section.key, pick)}${recommended}`,
          );
        } else {
          unpicked.push(section.title);
          if (!note) continue;
          groupLines.push(
            `- ${section.title}: not picked (recommended ${describeAlternative(section.key, section.recommended)})`,
          );
        }
      } else if (note) {
        groupLines.push(`- ${section.title}`);
      } else {
        continue;
      }
      if (note) {
        for (const [index, line] of note.split(/\r?\n/).entries()) {
          groupLines.push(`${index === 0 ? "  Note: " : "        "}${line}`);
        }
      }
    }
    if (groupLines.length > 0) {
      lines.push("", group, ...groupLines);
    }
  }

  if (unpicked.length > 0) {
    lines.push("", `Not picked yet (the recommended version is used): ${unpicked.join(", ")}`);
  }
  if (progress.picked === 0 && Object.keys(state.notes).length === 0) {
    lines.push("", "No picks or notes yet.");
  }
  return lines.join("\n");
}
