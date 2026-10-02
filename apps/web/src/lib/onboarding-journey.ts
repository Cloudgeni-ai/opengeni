import { useSyncExternalStore } from "react";

import { EMPTY_FIRST_AGENT, parseFirstAgentAnswers, type FirstAgentAnswers } from "./first-agent";

/**
 * The first-run journey a person picked after creating (or joining) an
 * organization, and what the "Get started" checklist remembers about it.
 *
 * There is no server preference store for small UI state, so this lives in
 * the browser, keyed by the signed-in subject and the organization: another
 * person on the same browser, or the same person in another organization,
 * starts clean. Everything here is a convenience. Each checklist item's done
 * state comes from live data where the app can read it (a usable model, a
 * session, an API key); the stored marks only cover what the server cannot
 * tell (the playground tour, a copied command, a dismissal).
 *
 * Storage can be unavailable (private windows, blocked site data); reads then
 * return nothing and writes are dropped, and the app still works.
 */

export const ONBOARDING_INTENTS = ["build", "cloud", "explore"] as const;
export type OnboardingIntent = (typeof ONBOARDING_INTENTS)[number];

/**
 * The chosen paths in canonical order. Build and cloud combine; "explore"
 * ("Just look around") stands alone.
 */
export function normalizeIntents(values: readonly unknown[]): OnboardingIntent[] {
  const chosen = new Set(values.filter(isOnboardingIntent));
  if (chosen.has("build") || chosen.has("cloud"))
    return ONBOARDING_INTENTS.filter((intent) => intent !== "explore" && chosen.has(intent));
  return chosen.has("explore") ? ["explore"] : [];
}

/** The path whose first step comes first: Build, then cloud, then look around. */
export function primaryIntent(intents: readonly OnboardingIntent[]): OnboardingIntent | null {
  return ONBOARDING_INTENTS.find((intent) => intents.includes(intent)) ?? null;
}

export function sameIntents(
  left: readonly OnboardingIntent[],
  right: readonly OnboardingIntent[],
): boolean {
  const a = normalizeIntents(left);
  const b = normalizeIntents(right);
  return a.length === b.length && a.every((intent, index) => intent === b[index]);
}

/**
 * Analytics for a choice of paths: every chosen value (`intents` "build,cloud"
 * plus one flag each) and the leading one as `intent`, so single-path charts
 * keep working.
 */
export function intentAnalyticsProperties(
  intents: readonly OnboardingIntent[],
): Record<string, string | boolean> {
  const chosen = normalizeIntents(intents);
  return {
    intent: primaryIntent(chosen) ?? "none",
    intents: chosen.length > 0 ? chosen.join(",") : "none",
    build: chosen.includes("build"),
    cloud: chosen.includes("cloud"),
    explore: chosen.includes("explore"),
  };
}

/** Things only the browser knows happened. */
export const ONBOARDING_MARKS = [
  "playground",
  "api_key",
  "first_api_session",
  "coding_agent",
  "first_task",
  "github_skipped",
  /** A credits checkout started from Get started. */
  "credits_checkout",
  /** First run's ready moment (the credits and the confetti) was shown. */
  "celebrated",
] as const;
export type OnboardingMark = (typeof ONBOARDING_MARKS)[number];

export type OnboardingJourney = Readonly<{
  version: 1;
  /** The chosen paths; empty until the person picks. */
  intents: readonly OnboardingIntent[];
  /** True for someone who joined an existing organization by invitation. */
  invited: boolean;
  /** The shared workspace the Build path uses for the playground and API keys. */
  developmentWorkspaceId: string | null;
  /** The checklist stays on the new-chat page until it is dismissed. */
  checklistDismissed: boolean;
  /** What the person entered in first run, kept as they go. */
  firstAgent: FirstAgentAnswers;
  marks: Partial<Record<OnboardingMark, string>>;
  startedAt: string;
}>;

type JourneyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_PREFIX = "og.get-started:v1";

export function onboardingJourneyStorageKey(subjectId: string, organizationId: string): string {
  return [STORAGE_PREFIX, encodeURIComponent(subjectId), encodeURIComponent(organizationId)].join(
    ":",
  );
}

export function isOnboardingIntent(value: unknown): value is OnboardingIntent {
  return typeof value === "string" && (ONBOARDING_INTENTS as readonly string[]).includes(value);
}

export function newOnboardingJourney(
  input: {
    intents?: readonly OnboardingIntent[];
    invited?: boolean;
    developmentWorkspaceId?: string | null;
  } = {},
  now: Date = new Date(),
): OnboardingJourney {
  return {
    version: 1,
    intents: normalizeIntents(input.intents ?? []),
    invited: input.invited ?? false,
    developmentWorkspaceId: input.developmentWorkspaceId ?? null,
    checklistDismissed: false,
    firstAgent: EMPTY_FIRST_AGENT,
    marks: {},
    startedAt: now.toISOString(),
  };
}

/** Parse a stored journey, dropping anything that is not exactly our shape. */
export function parseOnboardingJourney(raw: string | null): OnboardingJourney | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const marks: Partial<Record<OnboardingMark, string>> = {};
  if (record.marks && typeof record.marks === "object") {
    for (const mark of ONBOARDING_MARKS) {
      const at = (record.marks as Record<string, unknown>)[mark];
      if (typeof at === "string" && at.length <= 40) marks[mark] = at;
    }
  }
  return {
    version: 1,
    // Earlier builds stored one `intent`.
    intents: normalizeIntents(
      Array.isArray(record.intents) ? record.intents : [record.intent].filter(Boolean),
    ),
    invited: record.invited === true,
    developmentWorkspaceId:
      typeof record.developmentWorkspaceId === "string" &&
      record.developmentWorkspaceId.length <= 64
        ? record.developmentWorkspaceId
        : null,
    checklistDismissed: record.checklistDismissed === true,
    firstAgent: parseFirstAgentAnswers(record.firstAgent),
    marks,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date(0).toISOString(),
  };
}

function browserStorage(): JourneyStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
// useSyncExternalStore needs a stable snapshot per key between writes.
const snapshots = new Map<string, OnboardingJourney | null>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function readOnboardingJourney(
  key: string,
  storage: JourneyStorage | null = browserStorage(),
): OnboardingJourney | null {
  if (snapshots.has(key)) return snapshots.get(key) ?? null;
  let journey: OnboardingJourney | null = null;
  try {
    journey = parseOnboardingJourney(storage?.getItem(key) ?? null);
  } catch {
    journey = null;
  }
  snapshots.set(key, journey);
  return journey;
}

export function writeOnboardingJourney(
  key: string,
  journey: OnboardingJourney | null,
  storage: JourneyStorage | null = browserStorage(),
): void {
  snapshots.set(key, journey);
  try {
    if (journey) storage?.setItem(key, JSON.stringify(journey));
    else storage?.removeItem(key);
  } catch {
    // The journey still works for this page view when storage is blocked.
  }
  notify();
}

export function updateOnboardingJourney(
  key: string,
  update: (current: OnboardingJourney) => OnboardingJourney,
  storage: JourneyStorage | null = browserStorage(),
): OnboardingJourney {
  const next = update(readOnboardingJourney(key, storage) ?? newOnboardingJourney());
  writeOnboardingJourney(key, next, storage);
  return next;
}

export function markOnboarding(
  key: string,
  mark: OnboardingMark,
  now: Date = new Date(),
  storage: JourneyStorage | null = browserStorage(),
): void {
  const current = readOnboardingJourney(key, storage);
  // Only an active journey records marks; nothing starts one implicitly.
  if (!current || current.marks[mark]) return;
  writeOnboardingJourney(
    key,
    { ...current, marks: { ...current.marks, [mark]: now.toISOString() } },
    storage,
  );
}

/** Forget cached snapshots, so another tab's write is read again. */
export function refreshOnboardingJourneys(): void {
  snapshots.clear();
  notify();
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) refreshOnboardingJourneys();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

/** The journey for this person in this organization, live across components and tabs. */
export function useOnboardingJourney(key: string | null): OnboardingJourney | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? readOnboardingJourney(key) : null),
    () => null,
  );
}

export function resetOnboardingJourneysForTests(): void {
  snapshots.clear();
  listeners.clear();
}
