/**
 * Produces a distinct DOM text mutation for each pin result, including retries
 * that have the same human-readable result. Screen readers commonly ignore a
 * live region whose text node did not change, so alternate zero-width markers
 * after the spoken message. The markers are deliberately not audible.
 */
export function pinLiveAnnouncement(message: string, sequence: number): string {
  return `${message}${sequence % 2 === 0 ? "\u200C" : "\u200B"}`;
}
