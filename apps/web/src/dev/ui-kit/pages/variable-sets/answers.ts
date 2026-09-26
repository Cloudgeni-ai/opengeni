import { useSyncExternalStore } from "react";

import type { FormVariant } from "@/components/ui/form-dialog";
import type { LineTabsVariant } from "@/components/ui/line-tabs";
import type { RowListVariant } from "@/components/ui/list-row";
import type { MetaChipVariant } from "@/components/ui/meta-chip";
import type { PageHeaderIconMode, PageHeaderVariant } from "@/components/ui/page-header";
import type { SectionVariant } from "@/components/ui/section";
import type { SegmentedControlVariant } from "@/components/ui/segmented-control";

import { usePick } from "../../picks";

/* ----------------------------------------------------------------------------
   Bendik's picks, translated into the props the Variable sets pages need.
   -------------------------------------------------------------------------- */

export type NavLayout = "column" | "rail" | "tabs";
export type EmptyLook = "page" | "inline" | "templates";
export type DeleteStyle = "consequences" | "type-to-confirm" | "undo";

export interface PagePicks {
  nav: NavLayout;
  headerVariant: PageHeaderVariant;
  /** Settings sub-pages: whether the page title keeps its icon. */
  settingsIcon: PageHeaderIconMode;
  /** Main-rail pages (the Settings header in the tabs layout). */
  railIcon: PageHeaderIconMode;
  section: SectionVariant;
  list: RowListVariant;
  empty: EmptyLook;
  form: Exclude<FormVariant, "sheet">;
  destructive: DeleteStyle;
  segmented: SegmentedControlVariant;
  chip: MetaChipVariant;
  tabs: LineTabsVariant;
}

export function usePagePicks(): PagePicks {
  const navigation = usePick("navigation");
  const header = usePick("page-header");
  const section = usePick("section");
  const list = usePick("list-row");
  const empty = usePick("empty-state");
  const form = usePick("form-dialog");
  const destructive = usePick("destructive-confirm");
  const segmented = usePick("segmented-control");
  const badge = usePick("status-badge");
  const tabs = usePick("tabs-toolbar");
  return {
    nav: navigation === "b" ? "rail" : navigation === "c" ? "tabs" : "column",
    headerVariant: header === "c" ? "large" : "default",
    settingsIcon: header === "a" ? "show" : "hide",
    railIcon: header === "c" ? "hide" : "show",
    section: section === "b" ? "group" : section === "c" ? "tiles" : "open",
    list: list === "a" ? "catalog" : list === "c" ? "table" : "resource",
    empty: empty === "b" ? "inline" : empty === "c" ? "templates" : "page",
    form: form === "b" ? "page" : form === "c" ? "inline" : "dialog",
    destructive:
      destructive === "b" ? "type-to-confirm" : destructive === "c" ? "undo" : "consequences",
    segmented: segmented === "b" ? "outlined" : segmented === "c" ? "underline" : "filled",
    chip: badge === "a" ? "text" : badge === "c" ? "soft" : "outline",
    tabs: tabs === "b" ? "pill" : "underline",
  };
}

/* ----------------------------------------------------------------------------
   Answers to the open product questions (brief section 12, Q16-Q21). Bendik
   hasn't answered yet, so every page preview can show either answer. Stored
   in this browser so both page previews, both panes and the 390px frames
   agree.
   -------------------------------------------------------------------------- */

export interface VariableSetAnswers {
  /** Q16: one verb (Delete, Replace value), or today's Revoke and Rotate. */
  verbs: "delete" | "revoke";
  /** Q17: reveal secret values in the web UI. */
  reveal: "no" | "yes";
  /** Q17, next step: the per-variable Secret flag, so plain config shows inline. */
  plain: "hidden" | "shown";
  /** Q18: version numbers and the masked •••••• preview. */
  versions: "removed" | "kept";
  /** Q19: where a set opens. */
  opens: "page" | "sheet" | "inline";
  /** Q21: deleting a set that is in use. */
  inUse: "explain" | "disable";
}

export type AnswerKey = keyof VariableSetAnswers;

const STORAGE_KEY = "opengeni-ui-kit-variable-set-answers-v1";

type StoredAnswers = Partial<VariableSetAnswers>;

let cachedRaw: string | null | undefined;
let cached: StoredAnswers = {};
let memory: StoredAnswers | null = null;
const listeners = new Set<() => void>();

function read(): StoredAnswers {
  if (memory) return memory;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cached = raw ? (JSON.parse(raw) as StoredAnswers) : {};
    } catch {
      cached = {};
    }
  }
  return cached;
}

function write(next: StoredAnswers) {
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
    cachedRaw = raw;
    cached = next;
    memory = null;
  } catch {
    memory = next;
  }
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) {
    for (const listener of listeners) listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

const EMPTY: StoredAnswers = {};

/** The recommended answer to every question, adjusted by related component picks. */
export function useRecommendedAnswers(): VariableSetAnswers {
  const secretValues = usePick("secret-values");
  const detail = usePick("detail-sheet");
  return {
    verbs: "delete",
    reveal: secretValues === "b" ? "yes" : "no",
    plain: secretValues === "c" ? "shown" : "hidden",
    versions: "removed",
    // The brief puts variable sets on their own page; only "expand in place" changes that.
    opens: detail === "c" ? "inline" : "page",
    inUse: "explain",
  };
}

export function useAnswers(): VariableSetAnswers {
  const stored = useSyncExternalStore(subscribe, read, () => EMPTY);
  const recommended = useRecommendedAnswers();
  return { ...recommended, ...stored };
}

/** Answers explicitly changed in the toggles, or an empty object. */
export function useStoredAnswers(): StoredAnswers {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function setAnswer<Key extends AnswerKey>(key: Key, value: VariableSetAnswers[Key]) {
  write({ ...read(), [key]: value });
}

export function resetAnswers() {
  write({});
}

/** Q16: the verbs the page uses. */
export function useVerbs() {
  const { verbs } = useAnswers();
  return verbs === "revoke"
    ? {
        replace: "Rotate",
        replacing: "Rotating…",
        replaced: "Rotated",
        remove: "Revoke",
        removing: "Revoking…",
        removed: "Revoked",
      }
    : {
        replace: "Replace value",
        replacing: "Replacing…",
        replaced: "Replaced",
        remove: "Delete",
        removing: "Deleting…",
        removed: "Deleted",
      };
}
