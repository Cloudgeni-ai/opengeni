#!/usr/bin/env bun
/** Compare baseline/candidate file pairs without mixing milestone populations. */
type Event = { type: string; occurredAt: string; payload: { phase?: string } };
type Sample = {
  dispatchedAt: number;
  httpToDispatchMs: number;
  phases: Record<string, number[]>;
  events: Event[];
};
const paths = process.argv.slice(2);
if (paths.length < 2 || paths.length % 2) throw new Error("Pass before/after file pairs");
const groups: [Sample[], Sample[]] = [[], []];
for (const [index, path] of paths.entries()) {
  const data = (await Bun.file(path).json()) as { samples: Sample[] };
  groups[index % 2]!.push(...data.samples);
}
const distribution = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
};
const summarize = (samples: Sample[]) => {
  if (samples.length < 30) throw new Error("At least 30 samples per side required");
  const time = (s: Sample, type: string, phase?: string) => {
    const event = s.events.find((e) => e.type === type && (!phase || e.payload.phase === phase));
    if (!event) throw new Error(`Missing ${type}/${phase}`);
    return Date.parse(event.occurredAt);
  };
  const intervals = samples.map((s) => {
    const queued = time(s, "turn.queued");
    const started = time(s, "turn.started");
    const minted = time(s, "turn.startup.phase.completed", "credential_mint");
    const toolsStart = time(s, "turn.startup.phase.started", "tools");
    const toolsEnd = time(s, "turn.startup.phase.completed", "tools");
    const preparation = time(s, "turn.startup.phase.started", "model_preparation");
    const request = time(s, "agent.model.request", "started");
    return {
      httpToDispatch: s.httpToDispatchMs,
      httpToQueued: s.httpToDispatchMs - (s.dispatchedAt - queued),
      queuedToDispatch: s.dispatchedAt - queued,
      queuedToRequestEvent: request - queued,
      queuedToStarted: started - queued,
      startedToMint: minted - started,
      mintToTools: toolsStart - minted,
      tools: toolsEnd - toolsStart,
      toolsToPreparation: preparation - toolsEnd,
      preparationToRequestEvent: request - preparation,
      requestEventToDispatch: s.dispatchedAt - request,
      // Exact per-sample residual, not subtraction of independent percentiles.
      dispatchAndSetupBeforeClaim:
        started -
        queued -
        (s.phases.claim_and_policy?.[0] ?? 0) -
        (s.phases.turn_start_settlement?.[0] ?? 0),
    };
  });
  return {
    intervalsMs: Object.fromEntries(
      Object.keys(intervals[0]!).map((key) => [
        key,
        distribution(intervals.map((row) => row[key as keyof typeof row])),
      ]),
    ),
    phasesMs: Object.fromEntries(
      [...new Set(samples.flatMap((s) => Object.keys(s.phases)))]
        .sort()
        .map((phase) => [phase, distribution(samples.flatMap((s) => s.phases[phase] ?? []))]),
    ),
  };
};
console.log(JSON.stringify({ before: summarize(groups[0]), after: summarize(groups[1]) }, null, 2));
