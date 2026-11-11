import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { SearchRecord } from "./types";

export const RECALL_DEPTHS = [1, 5, 10, 20, 50, 100, 200] as const;

export type SearchScore = {
  /** The first loaded tool is acceptable. */
  firstPick: boolean;
  /** Some loaded tool is acceptable. */
  loadedRight: boolean;
  /** Some loaded or shown tool is acceptable: the agent can get there with at most one more call. */
  visible: boolean;
  /** The search's needs (one unless the scenario lists several). */
  needs: number;
  /** Needs with a loaded tool that serves them. */
  needsLoaded: number;
  /** Needs with a loaded or shown tool that serves them. */
  needsVisible: number;
  offLabelLoaded: number;
  agentTokens: number;
  /** 1-based rank of the first acceptable tool in the first stage's candidates, if ranked. */
  candidateRank?: number;
};

export function scoreSearch(record: SearchRecord): SearchScore | undefined {
  const trace = record.trace;
  if (!trace) return undefined;
  // A search where no tool fits is right when it loads nothing.
  if (!record.acceptable.length) {
    const empty = trace.loaded.length === 0;
    return {
      firstPick: empty,
      loadedRight: empty,
      visible: empty,
      needs: 1,
      needsLoaded: Number(empty),
      needsVisible: Number(empty),
      offLabelLoaded: trace.loaded.length,
      agentTokens: encode(trace.agentText).length,
    };
  }
  const ok = (toolName: string) => record.acceptable.includes(toolName);
  const needs = record.needs?.length ? record.needs : [record.acceptable];
  const shown = [...trace.loaded, ...trace.shown];
  const candidates = trace.stages.find((stage) => stage.name === "candidates")?.candidates;
  const rank = candidates?.findIndex((candidate) => ok(candidate.name));
  return {
    firstPick: trace.loaded.length > 0 && ok(trace.loaded[0]!),
    loadedRight: trace.loaded.some(ok),
    visible: shown.some(ok),
    needs: needs.length,
    needsLoaded: needs.filter((need) => need.some((name) => trace.loaded.includes(name))).length,
    needsVisible: needs.filter((need) => need.some((name) => shown.includes(name))).length,
    offLabelLoaded: trace.loaded.filter((toolName) => !ok(toolName)).length,
    agentTokens: encode(trace.agentText).length,
    ...(rank !== undefined && rank >= 0 ? { candidateRank: rank + 1 } : {}),
  };
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
/** Sum of parts over sum of wholes. */
const ratio = (pairs: [number, number][]) => {
  const whole = pairs.reduce((sum, [, of]) => sum + of, 0);
  return whole ? pairs.reduce((sum, [part]) => sum + part, 0) / whole : 0;
};
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;

/** 95% Wilson score interval for a proportion, as [low, high]. */
export function wilson(share: number, count: number): [number, number] {
  if (!count) return [0, 0];
  const z = 1.96;
  const denominator = 1 + (z * z) / count;
  const centre = share + (z * z) / (2 * count);
  const margin = z * Math.sqrt((share * (1 - share)) / count + (z * z) / (4 * count * count));
  return [
    Math.max(0, (centre - margin) / denominator),
    Math.min(1, (centre + margin) / denominator),
  ];
}

export type Summary = {
  searches: number;
  /** Searches that produced a scored result (errors excluded). */
  scored: number;
  errors: number;
  firstPick: number;
  loadedRight: number;
  visible: number;
  /** Share of all needs that the search loaded a tool for. */
  needsLoaded: number;
  /** Share of all needs that the search loaded or showed a tool for. */
  needsVisible: number;
  offLabelLoaded: number;
  meanAgentTokens: number;
  p95AgentTokens: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  meanCostUsd: number;
  totalCostUsd: number;
  fallbacks: number;
  /** Share of searches whose first stage ranked an acceptable tool within the top K. */
  recallAt?: Record<number, number>;
};

export function summarize(records: readonly SearchRecord[]): Summary {
  const scored = records.flatMap((record) => {
    const score = scoreSearch(record);
    return score && record.trace ? [{ score, trace: record.trace, record }] : [];
  });
  const ranked = scored.filter(
    ({ trace, record }) =>
      record.acceptable.length > 0 &&
      trace.stages.some((stage) => stage.name === "candidates" && stage.candidates),
  );
  return {
    searches: records.length,
    scored: scored.length,
    errors: records.filter((record) => record.error).length,
    firstPick: mean(scored.map(({ score }) => Number(score.firstPick))),
    loadedRight: mean(scored.map(({ score }) => Number(score.loadedRight))),
    visible: mean(scored.map(({ score }) => Number(score.visible))),
    needsLoaded: ratio(scored.map(({ score }) => [score.needsLoaded, score.needs])),
    needsVisible: ratio(scored.map(({ score }) => [score.needsVisible, score.needs])),
    offLabelLoaded: mean(scored.map(({ score }) => score.offLabelLoaded)),
    meanAgentTokens: mean(scored.map(({ score }) => score.agentTokens)),
    p95AgentTokens: percentile(
      scored.map(({ score }) => score.agentTokens),
      0.95,
    ),
    meanLatencyMs: mean(scored.map(({ trace }) => trace.latencyMs)),
    p95LatencyMs: percentile(
      scored.map(({ trace }) => trace.latencyMs),
      0.95,
    ),
    p99LatencyMs: percentile(
      scored.map(({ trace }) => trace.latencyMs),
      0.99,
    ),
    meanCostUsd: mean(scored.map(({ trace }) => trace.costUsd)),
    totalCostUsd: scored.reduce((sum, { trace }) => sum + trace.costUsd, 0),
    fallbacks: scored.filter(({ trace }) => trace.fallback).length,
    ...(ranked.length
      ? {
          recallAt: Object.fromEntries(
            RECALL_DEPTHS.map((depth) => [
              depth,
              mean(
                ranked.map(({ score }) =>
                  Number(score.candidateRank !== undefined && score.candidateRank <= depth),
                ),
              ),
            ]),
          ),
        }
      : {}),
  };
}
