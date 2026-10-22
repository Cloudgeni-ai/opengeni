import type { HumanInputQuestion } from "@opengeni/sdk";
import type { HumanInputAnswerDraft } from "./human-input-model";

/**
 * Unsent answers to a structured human-input request, so navigating away from
 * a session (Settings, another session) and back keeps what was typed.
 *
 * Same browser-side shadow as the composer's pending-send record: a module
 * map for in-app navigation, mirrored best effort to tab-scoped
 * sessionStorage for reloads. Keyed by workspace, session and request; one
 * entry holds that request's per-question drafts. Secret questions are never
 * stored (their values live only in uncontrolled inputs). Entries are bounded
 * in count, size and age, and are forgotten on submit or skip, on expiry, and
 * once the authoritative pending list no longer contains the request.
 */

export type HumanInputDraftScope = {
  workspaceId: string;
  sessionId: string;
  requestId: string;
};

type StoredHumanInputDraft = {
  v: 1;
  savedAt: number;
  drafts: Record<string, HumanInputAnswerDraft>;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const STORAGE_PREFIX = "opengeni.human-input-draft.v1:";
/** Most unsent request drafts kept per tab; the oldest are dropped first. */
export const HUMAN_INPUT_DRAFT_MAX_ENTRIES = 20;
/** Unsent drafts older than this are discarded. */
export const HUMAN_INPUT_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Serialized size cap per request; larger drafts stay in memory only. */
const MAX_SERIALIZED_LENGTH = 64 * 1024;

const memory = new Map<string, StoredHumanInputDraft>();

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopePrefix(workspaceId: string, sessionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(sessionId)}:`;
}

export function humanInputDraftKey(scope: HumanInputDraftScope): string {
  return `${scopePrefix(scope.workspaceId, scope.sessionId)}${encodeURIComponent(scope.requestId)}`;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAnswerDraft(value: unknown): value is HumanInputAnswerDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    stringList(record.values) &&
    typeof record.other === "string" &&
    typeof record.otherSelected === "boolean"
  );
}

function parseStored(raw: string | null): StoredHumanInputDraft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || typeof record.savedAt !== "number") return null;
    if (typeof record.drafts !== "object" || record.drafts === null) return null;
    const drafts: Record<string, HumanInputAnswerDraft> = {};
    for (const [questionId, draft] of Object.entries(record.drafts)) {
      if (isAnswerDraft(draft)) drafts[questionId] = draft;
    }
    return { v: 1, savedAt: record.savedAt, drafts };
  } catch {
    return null;
  }
}

function storageKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
  } catch {
    // Unreadable storage: only the in-memory map applies.
  }
  return keys;
}

function removeKey(key: string, storage: DraftStorage | null = browserStorage()): void {
  memory.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    // Best effort, like the composer's pending-send record.
  }
}

function isEmptyDraft(draft: HumanInputAnswerDraft): boolean {
  return draft.values.every((value) => value === "") && !draft.otherSelected && draft.other === "";
}

/** Keep only what still fits the request's current non-secret questions. */
function fitToQuestions(
  questions: readonly HumanInputQuestion[],
  drafts: Record<string, HumanInputAnswerDraft>,
): Record<string, HumanInputAnswerDraft> {
  const fitted: Record<string, HumanInputAnswerDraft> = {};
  for (const question of questions) {
    if (question.kind === "secret") continue;
    const draft = drafts[question.id];
    if (!draft) continue;
    if (question.kind === "text") {
      fitted[question.id] = { values: draft.values.slice(0, 1), other: "", otherSelected: false };
      continue;
    }
    const optionIds = new Set(question.options.map((option) => option.id));
    const values = draft.values.filter((value) => optionIds.has(value));
    // The card offers Other on every choice question except a Skill review.
    const otherOffered = !question.skillReview;
    fitted[question.id] = {
      values: question.kind === "single_select" ? values.slice(0, 1) : values,
      other: otherOffered ? draft.other : "",
      otherSelected: otherOffered ? draft.otherSelected : false,
    };
  }
  return fitted;
}

function expired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) && deadline <= now;
}

/**
 * The saved unsent answers for a request, or null. An expired request or a
 * stale entry is forgotten instead of restored.
 */
export function readHumanInputDraft(
  scope: HumanInputDraftScope,
  request: { questions: readonly HumanInputQuestion[]; expiresAt?: string | null | undefined },
  now: number = Date.now(),
): Record<string, HumanInputAnswerDraft> | null {
  const key = humanInputDraftKey(scope);
  const storage = browserStorage();
  let stored = memory.get(key) ?? null;
  if (!stored) {
    try {
      stored = parseStored(storage?.getItem(key) ?? null);
    } catch {
      stored = null;
    }
  }
  if (!stored) return null;
  if (expired(request.expiresAt, now) || now - stored.savedAt > HUMAN_INPUT_DRAFT_MAX_AGE_MS) {
    removeKey(key, storage);
    return null;
  }
  const fitted = fitToQuestions(request.questions, stored.drafts);
  return Object.values(fitted).some((draft) => !isEmptyDraft(draft)) ? fitted : null;
}

/**
 * Save the non-secret drafts for a request. An all-empty draft forgets the
 * entry, so clearing every field leaves nothing behind.
 */
export function writeHumanInputDraft(
  scope: HumanInputDraftScope,
  questions: readonly HumanInputQuestion[],
  drafts: Record<string, HumanInputAnswerDraft>,
  now: number = Date.now(),
): void {
  const key = humanInputDraftKey(scope);
  const storage = browserStorage();
  const fitted = Object.fromEntries(
    Object.entries(fitToQuestions(questions, drafts)).filter(([, draft]) => !isEmptyDraft(draft)),
  );
  if (Object.keys(fitted).length === 0) {
    removeKey(key, storage);
    return;
  }
  const entry: StoredHumanInputDraft = { v: 1, savedAt: now, drafts: fitted };
  memory.delete(key);
  memory.set(key, entry);
  enforceBounds(storage, now, key);
  if (!storage) return;
  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length > MAX_SERIALIZED_LENGTH) storage.removeItem(key);
    else storage.setItem(key, serialized);
  } catch {
    // Quota or privacy mode: the in-memory copy still survives navigation.
  }
}

/** Forget a request's draft (submitted, skipped, expired or resolved elsewhere). */
export function forgetHumanInputDraft(scope: HumanInputDraftScope): void {
  removeKey(humanInputDraftKey(scope));
}

/**
 * Forget every draft in a session whose request is no longer pending, given
 * an authoritative pending list. Drafts saved at or after `readStartedAt`
 * are kept: that read may predate the request they belong to.
 */
export function pruneHumanInputDrafts(
  workspaceId: string,
  sessionId: string,
  pendingRequestIds: Iterable<string>,
  readStartedAt: number,
): void {
  const prefix = scopePrefix(workspaceId, sessionId);
  const keep = new Set([...pendingRequestIds].map((id) => `${prefix}${encodeURIComponent(id)}`));
  const storage = browserStorage();
  const candidates = new Set([...memory.keys()].filter((key) => key.startsWith(prefix)));
  if (storage)
    for (const key of storageKeys(storage)) if (key.startsWith(prefix)) candidates.add(key);
  for (const key of candidates) {
    if (keep.has(key)) continue;
    const savedAt = memory.get(key)?.savedAt ?? savedAtInStorage(storage, key);
    if (savedAt !== null && savedAt >= readStartedAt) continue;
    removeKey(key, storage);
  }
}

function savedAtInStorage(storage: DraftStorage | null, key: string): number | null {
  try {
    return parseStored(storage?.getItem(key) ?? null)?.savedAt ?? null;
  } catch {
    return null;
  }
}

/** Drop stale entries, then the oldest beyond the per-tab cap (never `current`). */
function enforceBounds(storage: DraftStorage | null, now: number, current: string): void {
  const entries = new Map<string, number>();
  for (const [key, entry] of memory) entries.set(key, entry.savedAt);
  if (storage) {
    for (const key of storageKeys(storage)) {
      if (entries.has(key)) continue;
      // Unparseable entries sort first and are dropped.
      entries.set(key, savedAtInStorage(storage, key) ?? Number.NEGATIVE_INFINITY);
    }
  }
  const live: Array<[string, number]> = [];
  for (const [key, savedAt] of entries) {
    if (key === current) continue;
    if (now - savedAt > HUMAN_INPUT_DRAFT_MAX_AGE_MS) removeKey(key, storage);
    else live.push([key, savedAt]);
  }
  live.sort((left, right) => left[1] - right[1]);
  const excess = Math.max(0, live.length + 1 - HUMAN_INPUT_DRAFT_MAX_ENTRIES);
  for (const [key] of live.slice(0, excess)) {
    removeKey(key, storage);
  }
}

/** Test seam: forget the in-memory map (simulates a reload). */
export function resetHumanInputDraftMemoryForTests(): void {
  memory.clear();
}
