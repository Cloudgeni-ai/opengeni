/**
 * The sustained-rate search: step the offered rate up a ladder until a step
 * does not hold, then halve the gap between the last rate that held and the
 * first that did not a few times.
 */
import type { Outcome } from "./load.ts";
import { summarize, type Summary } from "./stats.ts";

export interface StepResult {
  rate: number;
  /** Outcomes measured after the warm-up. */
  measured: number;
  errors: number;
  starved: number;
  /** Completed operations a second over the measured window. */
  completedRate: number;
  latency?: Summary;
  holds: boolean;
  /** Why it did not hold. */
  reason?: string;
  /** The first few error messages, for the record. */
  sampleErrors?: string[];
  /**
   * The search cannot go on after it: sandboxes were lost, so a later step
   * would test a smaller population than N.
   */
  ends?: boolean;
}

export interface Criteria {
  /** The p99 a step must stay under, in milliseconds. */
  p99LimitMs: number;
  /** Fewest measured operations for a step to count. */
  minSamples: number;
}

export const DEFAULT_CRITERIA: Criteria = { p99LimitMs: 1000, minSamples: 20 };

/** Arrivals a step's measured window carries at least, so a low rate is not judged on a handful. */
export const MIN_EXPECTED_SAMPLES = 40;

/**
 * How long one step offers `rate`: the warm-up, then a measured window of
 * at least `measuredMs`, longer at low rates so that it expects
 * `MIN_EXPECTED_SAMPLES` arrivals (and, with arrivals conditioned on their
 * count, gets them).
 */
export function stepWindow(rate: number, measuredMs: number, warmupMs: number): { stepMs: number; measuredMs: number } {
  const measured = Math.max(measuredMs, Math.ceil((MIN_EXPECTED_SAMPLES / rate) * 1000));
  return { stepMs: warmupMs + measured, measuredMs: measured };
}

/**
 * Judges one step from its outcomes. Only arrivals scheduled at or after
 * `warmupMs` count, and `measuredMs` is the length of that window. Every
 * arrival is waited for, so a system that falls behind shows it in the
 * p99, not in how many completed; the completed rate is reported, not
 * judged. `restFailures` counts the step's sandboxes that could not be put
 * back to rest: the system failed at half of each activation, so the step
 * does not hold.
 */
export function judgeStep(
  rate: number,
  outcomes: readonly Outcome[],
  warmupMs: number,
  measuredMs: number,
  criteria: Criteria = DEFAULT_CRITERIA,
  restFailures = 0,
): StepResult {
  const measured = outcomes.filter((outcome) => outcome.at >= warmupMs);
  const starved = measured.filter((outcome) => outcome.starved).length;
  const failed = measured.filter((outcome) => !outcome.ok && !outcome.starved);
  const errors = failed.length;
  const succeeded = measured.filter((outcome) => outcome.ok);
  const completedRate = succeeded.length / (measuredMs / 1000);
  const latency = succeeded.length > 0 ? summarize(succeeded.map((outcome) => outcome.latencyMs)) : undefined;
  const sampleErrors = [...new Set(failed.map((outcome) => outcome.error ?? "unknown"))].slice(0, 3);
  const base = { rate, measured: measured.length, errors: errors + restFailures, starved, completedRate, latency, sampleErrors };
  if (restFailures > 0) return { ...base, holds: false, ends: true, reason: `${restFailures} sandboxes failed to rest again` };
  // Starvation with no error is the client's limit; with errors, the errors decide.
  if (starved > 0 && errors === 0) return { ...base, holds: false, reason: "client-limited: no resting sandbox was free" };
  if (measured.length < criteria.minSamples) return { ...base, holds: false, reason: `only ${measured.length} samples` };
  if (errors > 0) return { ...base, holds: false, reason: `${errors} errors` };
  if (!latency || latency.p99 >= criteria.p99LimitMs) {
    return { ...base, holds: false, reason: `p99 ${Math.round(latency?.p99 ?? Number.POSITIVE_INFINITY)} ms` };
  }
  return { ...base, holds: true };
}

export interface SearchResult {
  /** The highest rate that held, or 0 when none did. */
  sustained: number;
  /** The lowest rate at which any error appeared, if one did. */
  errorOnset?: number;
  /** A step was client-limited: the search stopped without a verdict. */
  clientLimited: boolean;
  steps: StepResult[];
}

/**
 * Runs `step` up `ladder` (ascending) until a step does not hold, then
 * bisects `refinements` times between the last rate that held and the first
 * that did not. A client-limited step stops the search: it says nothing
 * about the system. So does a step that `ends` it, after which the
 * sandboxes left are no longer the N the search started with.
 */
export async function searchSustainedRate(
  ladder: readonly number[],
  step: (rate: number) => Promise<StepResult>,
  refinements = 3,
): Promise<SearchResult> {
  for (let i = 1; i < ladder.length; i++) {
    if (!(ladder[i] > ladder[i - 1])) throw new Error("the ladder must be strictly ascending");
  }
  const steps: StepResult[] = [];
  let good = 0;
  let bad: number | undefined;
  const run = async (rate: number) => {
    const result = await step(rate);
    steps.push(result);
    return result;
  };
  for (const rate of ladder) {
    const result = await run(rate);
    if (isClientLimited(result)) return finish(steps, good, true);
    if (result.ends) return finish(steps, good, false);
    if (!result.holds) {
      bad = rate;
      break;
    }
    good = rate;
  }
  for (let i = 0; bad !== undefined && i < refinements; i++) {
    const rate = roundRate((good + bad) / 2);
    if (rate <= good || rate >= bad) break;
    const result = await run(rate);
    if (isClientLimited(result)) return finish(steps, good, true);
    if (result.ends) return finish(steps, good, false);
    if (result.holds) good = rate;
    else bad = rate;
  }
  return finish(steps, good, false);
}

/** Some arrival found no resting sandbox and nothing failed: the client ran out, not the system. */
export function isClientLimited(step: StepResult): boolean {
  return step.starved > 0 && step.errors === 0;
}

function finish(steps: StepResult[], sustained: number, clientLimited: boolean): SearchResult {
  const erroring = steps.filter((step) => step.errors > 0).map((step) => step.rate);
  const errorOnset = erroring.length > 0 ? Math.min(...erroring) : undefined;
  return { sustained, errorOnset, clientLimited, steps };
}

/** Rates below 10 keep one decimal; higher ones are whole. */
export function roundRate(rate: number): number {
  return rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate);
}
