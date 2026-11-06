import { XAI_CLIENT_VERSION } from "./constants";

/**
 * The Grok CLI client version Opengeni presents to xAI.
 *
 * xAI enforces a minimum Grok CLI version on the subscription surfaces and
 * refuses older clients with "Grok CLI version (X) is outdated, update to Y".
 * `XAI_CLIENT_VERSION` is the pinned release (kept current by the scheduled
 * pin refresh); when the provider raises its minimum past the pin, the
 * refusal itself names the required version. This process adopts it as a
 * floor, so the next request (and the one-shot retry of the refused request)
 * presents a version the provider accepts instead of every Grok turn failing
 * until a new release ships.
 */

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
// The refusal sentence, tolerant of quoting and punctuation variants.
const OUTDATED_CLIENT =
  /grok\s+cli\s+version\s*\(?\s*v?(\d{1,6}\.\d{1,6}\.\d{1,6})[^)\s,]*\s*\)?\s*is\s+outdated[\s\S]{0,40}?update\s+to\s+v?(\d{1,6}\.\d{1,6}\.\d{1,6})/i;

let learnedFloor: string | null = null;

export type XaiClientVersionRejection = {
  /** The version the refused request presented. */
  sent: string;
  /** The minimum version the provider asked for. */
  required: string;
};

/** Compare two X.Y.Z versions; a malformed value orders lowest. */
export function compareXaiClientVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * The client version to present: the requested (or pinned) version, raised to
 * any minimum this process learned from a provider refusal.
 */
export function currentXaiClientVersion(requested?: string | null): string {
  const base = requested && SEMVER.test(requested) ? requested : XAI_CLIENT_VERSION;
  return learnedFloor && compareXaiClientVersions(learnedFloor, base) > 0 ? learnedFloor : base;
}

/** Read a provider refusal for an outdated client from an error body or message. */
export function parseXaiClientVersionRejection(
  text: string | null | undefined,
): XaiClientVersionRejection | null {
  if (!text) return null;
  const match = OUTDATED_CLIENT.exec(text.slice(0, 16 * 1024));
  if (!match) return null;
  return { sent: match[1]!, required: match[2]! };
}

/**
 * Adopt the minimum version named by a provider refusal. Returns the refusal
 * when it raised the version this process presents (so a retry can succeed),
 * otherwise null: an unparseable body, or a minimum we already present.
 */
export function adoptXaiClientVersionFloor(
  text: string | null | undefined,
  presented: string,
): XaiClientVersionRejection | null {
  const rejection = parseXaiClientVersionRejection(text);
  if (!rejection || !SEMVER.test(rejection.required)) return null;
  if (compareXaiClientVersions(rejection.required, presented) <= 0) return null;
  if (!learnedFloor || compareXaiClientVersions(rejection.required, learnedFloor) > 0) {
    learnedFloor = rejection.required;
  }
  return rejection;
}

/** Test seam: forget any learned floor. */
export function resetXaiClientVersionFloorForTests(): void {
  learnedFloor = null;
}
