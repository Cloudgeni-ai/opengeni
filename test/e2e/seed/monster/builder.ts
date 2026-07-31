/**
 * Deterministic monster timeline builder — orchestrates phases into an exact budget.
 */

import type { AppendEventInput } from "@opengeni/db";
import { createRng, EventBudget, hashHistogram, histogramOf } from "./budget.ts";
import { DEFAULT_SHARES, phaseTipChat, runAllPhases } from "./phases.ts";

export type MonsterProfile = "ui" | "monster" | "stress" | "payload-heavy";

export const PROFILE_TARGETS: Record<MonsterProfile, number> = {
  ui: 10_000,
  monster: 50_000,
  stress: 100_000,
  "payload-heavy": 8_000,
};

export type MonsterBuildOptions = {
  profile: MonsterProfile;
  seed: number;
  /** Real child session ids for session_create / childCompletion deep links. */
  childSessionIds: string[];
  targetOverride?: number;
};

export type MonsterBuildResult = {
  events: AppendEventInput[];
  histogram: Record<string, number>;
  histogramHash: string;
  target: number;
  profile: MonsterProfile;
  seed: number;
};

export { createRng, EventBudget, hashHistogram, histogramOf, uuidFromRng } from "./budget.ts";
export { DEFAULT_SHARES } from "./phases.ts";

export function resolveProfile(raw: string | undefined): MonsterProfile {
  const value = (raw ?? "monster").toLowerCase();
  if (value === "ui" || value === "monster" || value === "stress" || value === "payload-heavy") {
    return value;
  }
  throw new Error(
    `Unknown OPENGENI_SEED_MONSTER_PROFILE=${raw}; use ui|monster|stress|payload-heavy`,
  );
}

export function buildMonsterEvents(opts: MonsterBuildOptions): MonsterBuildResult {
  const target = opts.targetOverride ?? PROFILE_TARGETS[opts.profile];
  const rng = createRng(opts.seed);
  const budget = new EventBudget(target, rng);
  const fat = opts.profile === "payload-heavy";

  runAllPhases(budget, {
    children: opts.childSessionIds,
    fat,
    target,
    shares: DEFAULT_SHARES,
  });

  // Exact-count remainder must stay chat-dense at the tip — never pad the
  // newest window with non-rendering fs/usage noise.
  if (budget.count < target) {
    phaseTipChat(budget, fat);
  }
  if (budget.events.length > target) {
    budget.events.length = target;
  }

  const histogram = histogramOf(budget.events);
  return {
    events: budget.events,
    histogram,
    histogramHash: hashHistogram(histogram),
    target,
    profile: opts.profile,
    seed: opts.seed,
  };
}
