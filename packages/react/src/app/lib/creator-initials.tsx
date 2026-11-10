/**
 * Creator-initials presentation for rail rows. Derives a 1–2 letter monogram
 * plus a stable per-subject hue from a session's frozen `createdBy` fact.
 * Display-only: never an authorization input.
 */

export type CreatorRef = {
  kind: "subject" | "service";
  subjectId: string;
  label?: string | undefined;
};

/** Rows migrated before creation attribution carry this reserved subject id. */
const UNATTRIBUTED_LEGACY_SUBJECT_ID = "unattributed-legacy";

const API_KEY_SUBJECT_PREFIX = "api_key:";
const SERVICE_SUBJECT_PREFIX = "service:";

/** What kind of thing created a chat. Display-only. */
export type CreatorType = "person" | "api_key" | "service" | "unattributed";

/**
 * API keys are one creator whichever kind their sessions were frozen with:
 * older sessions recorded the key as a subject, newer ones as a service.
 */
export function creatorType(createdBy: Pick<CreatorRef, "kind" | "subjectId">): CreatorType {
  if (createdBy.subjectId === UNATTRIBUTED_LEGACY_SUBJECT_ID) return "unattributed";
  if (createdBy.subjectId.startsWith(API_KEY_SUBJECT_PREFIX)) return "api_key";
  if (createdBy.kind === "service" || createdBy.subjectId.startsWith(SERVICE_SUBJECT_PREFIX)) {
    return "service";
  }
  return "person";
}

/**
 * The one creator a session belongs to. Keyed by subject id alone, so the
 * subject- and service-frozen sessions of one API key share a group.
 */
export function creatorIdentityKey(createdBy: Pick<CreatorRef, "subjectId">): string {
  return createdBy.subjectId;
}

/**
 * How a non-person creator is named: the friendly name its owner gave it and a
 * short kind hint. Without a friendly name it is just its kind, never an id.
 * Null for people, whose labels are shown as frozen.
 */
export function machineCreatorDisplay(
  createdBy: CreatorRef,
): { name: string | null; hint: "API key" | "Service" } | null {
  const type = creatorType(createdBy);
  if (type !== "api_key" && type !== "service") return null;
  return {
    name: createdBy.label?.trim() || null,
    hint: type === "api_key" ? "API key" : "Service",
  };
}

/** A non-person creator's label ("Codex operator · API key", or just "API key"); null for people. */
export function machineCreatorLabel(createdBy: CreatorRef): string | null {
  const machine = machineCreatorDisplay(createdBy);
  if (!machine) return null;
  return machine.name ? `${machine.name} · ${machine.hint}` : machine.hint;
}

function humanizeSubjectId(subjectId: string): string {
  const withoutPrefix = subjectId.includes(":")
    ? subjectId.slice(subjectId.indexOf(":") + 1)
    : subjectId;
  return withoutPrefix.trim();
}

/**
 * 1–2 letter monogram for a human creator; null for service/system creators
 * and unattributed legacy rows (the rail shows people, not machinery).
 */
export function creatorInitials(createdBy: CreatorRef): string | null {
  // An API key is not a person, even on older rows that froze it as a subject.
  if (createdBy.kind !== "subject" || creatorType(createdBy) !== "person") {
    return null;
  }
  const label = createdBy.label?.trim();
  const source = label && label.length > 0 ? label : humanizeSubjectId(createdBy.subjectId);
  if (source.length === 0) {
    return null;
  }
  // Spread to code points so astral characters (emoji, supplementary-plane
  // scripts) are not split into lone surrogates.
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${[...words[0]!][0]}${[...words[1]!][0]}`.toUpperCase();
  }
  return [...source].slice(0, 2).join("").toUpperCase();
}

/**
 * The creator a rail row should show a monogram for, or null.
 *
 * Top-level rows only. A spawned session inherits its parent's creator, so
 * repeating the chip down a subtree is noise that costs title width on exactly
 * the rows with the least of it. `parentSessionId` is the session's own lineage
 * fact, which is why it beats the row's render depth: a collapsed channel
 * section renders the selected session at depth 0 even when it is nested.
 */
export function railRowCreator(session: {
  parentSessionId: string | null;
  createdBy: CreatorRef;
}): CreatorRef | null {
  return session.parentSessionId === null ? session.createdBy : null;
}

/** Human-readable creator name for a tooltip or screen-reader announcement. */
export function creatorLabel(createdBy: CreatorRef): string {
  const machine = machineCreatorLabel(createdBy);
  if (machine) return machine;
  return createdBy.label?.trim() || createdBy.subjectId;
}

/**
 * How a rail row announces its creator, or null when it shows no chip.
 *
 * The chip is `aria-hidden` and the row's own `aria-label` replaces
 * name-from-content, so the row's accessible name is the only place a screen
 * reader can hear this. Gate it on exactly the facts that decide whether the
 * chip renders, so a row never announces a creator it does not show.
 */
export function creatorAnnouncement(createdBy: CreatorRef | null): string | null {
  if (createdBy === null || creatorInitials(createdBy) === null) return null;
  return creatorLabel(createdBy);
}

/** Stable hue (0–359) hashed from the subject id, for the monogram chip. */
export function creatorHue(subjectId: string): number {
  let hash = 0;
  for (let index = 0; index < subjectId.length; index += 1) {
    hash = (hash * 31 + subjectId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
