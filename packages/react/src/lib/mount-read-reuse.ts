/**
 * A reader mounting this soon (ms) after another part of the page read the same
 * resource takes that read instead of sending it again. Changes and later
 * refreshes always read afresh.
 */
export const MOUNT_READ_REUSE_MS = 10_000;
