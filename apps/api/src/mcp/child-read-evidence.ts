/** Select only whole items that actually survived the model-facing envelope.
 * A cursor is a position, never proof that preceding content was consumed. */
export function completeChildReadSequences(page: {
  view: string;
  sourceExact: boolean;
  events: readonly ({ sequence: number } & Record<string, unknown>)[];
}): number[] {
  if (!page.sourceExact || !["conversation", "results"].includes(page.view)) return [];
  return page.events
    .filter((event) => {
      if (event.sourceOmitted) return false;
      if (event.fragment === undefined) return true;
      if (!event.fragment || typeof event.fragment !== "object") return false;
      const fragment = event.fragment as Record<string, unknown>;
      // A final fragment cannot prove earlier fragments were ever read.
      return fragment.offset === 0 && fragment.complete === true;
    })
    .map((event) => event.sequence);
}
