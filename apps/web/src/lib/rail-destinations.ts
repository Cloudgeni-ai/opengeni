// Which destinations a person keeps in the main rail. Everything else stays
// reachable under More.
//
// TODO(rail-preferences): there is no per-user UI preference API yet (the
// preference registry is agent knowledge, not UI settings). Until one exists
// the choice lives in localStorage, keyed by the signed-in subject, so it
// follows the person on this browser only. Move it server-side when a user
// preferences endpoint lands.
import { useCallback, useEffect, useState } from "react";

export type RailDestinationId =
  | "for-you"
  | "agents"
  | "schedules"
  | "artifacts"
  | "knowledge"
  | "capabilities"
  | "insights";

/** Every destination the rail can show, in rail order. Settings is fixed at the end. */
export const RAIL_DESTINATION_IDS: readonly RailDestinationId[] = [
  "for-you",
  "agents",
  "schedules",
  "artifacts",
  "knowledge",
  "capabilities",
  "insights",
];

/** The brief default: the pages people open most. */
export const DEFAULT_RAIL_DESTINATIONS: readonly RailDestinationId[] = [
  "schedules",
  "artifacts",
  "knowledge",
  "capabilities",
];

const STORAGE_VERSION = 1;
const CHANGE_EVENT = "og:rail-destinations-change";

type RailDestinationStorage = Pick<Storage, "getItem" | "setItem">;

export function railDestinationsStorageKey(subjectId: string): string {
  return ["og.rail.destinations", `v${STORAGE_VERSION}`, encodeURIComponent(subjectId)].join(":");
}

function browserStorage(): RailDestinationStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRailDestinationId(value: unknown): value is RailDestinationId {
  return typeof value === "string" && (RAIL_DESTINATION_IDS as readonly string[]).includes(value);
}

/** Puts ids in rail order and drops unknown or repeated ones. */
export function normalizeRailDestinations(ids: readonly unknown[]): RailDestinationId[] {
  const chosen = new Set(ids.filter(isRailDestinationId));
  return RAIL_DESTINATION_IDS.filter((id) => chosen.has(id));
}

export function readRailDestinations(
  subjectId: string,
  storage: RailDestinationStorage | null = browserStorage(),
): RailDestinationId[] {
  const fallback = [...DEFAULT_RAIL_DESTINATIONS];
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(railDestinationsStorageKey(subjectId));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeRailDestinations(parsed) : fallback;
  } catch {
    return fallback;
  }
}

export function writeRailDestinations(
  subjectId: string,
  ids: readonly RailDestinationId[],
  storage: RailDestinationStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      railDestinationsStorageKey(subjectId),
      JSON.stringify(normalizeRailDestinations(ids)),
    );
  } catch {
    // The rail keeps the in-memory choice when storage is blocked or full.
  }
}

/** The person's rail choice, kept in sync across every rail on the page. */
export function useRailDestinations(
  subjectId: string,
): [RailDestinationId[], (next: readonly RailDestinationId[]) => void] {
  const [ids, setIds] = useState(() => readRailDestinations(subjectId));
  useEffect(() => {
    setIds(readRailDestinations(subjectId));
    const sync = () => setIds(readRailDestinations(subjectId));
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [subjectId]);
  const update = useCallback(
    (next: readonly RailDestinationId[]) => {
      const normalized = normalizeRailDestinations(next);
      setIds(normalized);
      writeRailDestinations(subjectId, normalized);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [subjectId],
  );
  return [ids, update];
}
