/**
 * Neutral model-facing text for history media the current requester's file
 * authority excludes, for example another participant's private file in a
 * shared session. Authority exclusion and real unavailability stay
 * indistinguishable, and there is no fetch instruction that would fail and
 * lead the model to report the file as deleted.
 */
export function requesterUnavailableReceiptText(subject: string, noun: "file" | "image"): string {
  return (
    `[${subject}. This ${noun} is not available to the current requester: ` +
    `it may belong to another participant, or it may no longer be available. ` +
    `Its contents are not included and it cannot be downloaded in this turn; do not guess which.]`
  );
}
