#!/usr/bin/env bun
type Mark = { kind: string; at: number; queries: number };
type Sample = {
  marks: Mark[];
  phases: Record<string, number[]>;
  queries: string[];
  requests: string[];
  lifecycle: string[];
};
type Measurement = {
  summary: { steps: number; runs: number; databaseOneWayDelayMs: number };
  samples: Sample[];
};

const paths = process.argv.slice(2);
if (paths.length < 2 || paths.length % 2)
  throw new Error(
    "Usage: compare-agent-steps.ts before.json after.json [before2.json after2.json]",
  );
const before: Sample[] = [],
  after: Sample[] = [];
let shape: string | undefined;
for (let i = 0; i < paths.length; i++) {
  const result: Measurement = await Bun.file(paths[i]!).json();
  const current = JSON.stringify([result.summary.steps, result.summary.databaseOneWayDelayMs]);
  shape ??= current;
  if (shape !== current) throw new Error("Step count and transport delay must match");
  (i % 2 ? after : before).push(...result.samples);
}

const requestSequences = [...before, ...after].map((sample) =>
  JSON.stringify(sample.requests).replace(
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g,
    "<display-timestamp>",
  ),
);
if (!requestSequences.length || new Set(requestSequences).size !== 1)
  throw new Error("Ordered model requests differ within or between revisions");
const distribution = (values: number[]) => {
  if (!values.length) throw new Error("Missing observations");
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
};
const summarize = (samples: Sample[]) => {
  const gaps = (from: string, to: string, field: "at" | "queries") =>
    samples.flatMap((sample) =>
      sample.marks.flatMap((mark, i) =>
        mark.kind === from && sample.marks[i + 1]?.kind === to
          ? [sample.marks[i + 1]![field] - mark[field]]
          : [],
      ),
    );
  const modelToTool = gaps("model_done", "tool_start", "at");
  const toolToModel = gaps("tool_done", "dispatch", "at");
  if (modelToTool.length < 20 || modelToTool.length !== toolToModel.length)
    throw new Error("At least 20 complete steps are required");
  return {
    modelToToolMs: distribution(modelToTool),
    toolToModelMs: distribution(toolToModel),
    totalGapMs: distribution(modelToTool.map((value, i) => value + toolToModel[i]!)),
    modelToToolStatements: distribution(gaps("model_done", "tool_start", "queries")),
    toolToModelStatements: distribution(gaps("tool_done", "dispatch", "queries")),
    phasesMs: Object.fromEntries(
      [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))]
        .sort()
        .map((phase) => [
          phase,
          distribution(samples.flatMap((sample) => sample.phases[phase] ?? [])),
        ]),
    ),
    lifecycle: samples.map((sample) =>
      sample.lifecycle.reduce<Record<string, number>>((counts, phase) => {
        counts[phase] = (counts[phase] ?? 0) + 1;
        return counts;
      }, {}),
    ),
  };
};
console.log(
  JSON.stringify(
    {
      before: summarize(before),
      after: summarize(after),
      identicalOrderedRequestsSha256: new Bun.CryptoHasher("sha256")
        .update(requestSequences[0]!)
        .digest("hex"),
    },
    null,
    2,
  ),
);
