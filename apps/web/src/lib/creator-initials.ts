/**
 * Creator-initials presentation for rail rows. Derives a 1–2 letter monogram
 * plus a stable per-subject hue from a session's frozen `createdBy` fact.
 * Display-only: never an authorization input.
 */

type CreatorRef = {
  kind: "subject" | "service";
  subjectId: string;
  label?: string | undefined;
};

/** Rows migrated before creation attribution carry this reserved subject id. */
const UNATTRIBUTED_LEGACY_SUBJECT_ID = "unattributed-legacy";

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
  if (createdBy.kind !== "subject" || createdBy.subjectId === UNATTRIBUTED_LEGACY_SUBJECT_ID) {
    return null;
  }
  const label = createdBy.label?.trim();
  const source = label && label.length > 0 ? label : humanizeSubjectId(createdBy.subjectId);
  if (source.length === 0) {
    return null;
  }
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** Stable hue (0–359) hashed from the subject id, for the monogram chip. */
export function creatorHue(subjectId: string): number {
  let hash = 0;
  for (let index = 0; index < subjectId.length; index += 1) {
    hash = (hash * 31 + subjectId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
