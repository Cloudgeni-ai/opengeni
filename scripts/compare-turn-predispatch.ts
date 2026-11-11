#!/usr/bin/env bun

type Sample = {
  providerDispatchMs: number;
  phases: Record<string, number[]>;
  queries: string[];
  normalizedRequest: string;
};
type Measurement = { samples: Sample[]; continuationSamples: Sample[] };

// Pass baseline/candidate file pairs in execution-independent order. Keeping
// both pairs supports an A/B/B/A experiment without selecting favorable runs.
const paths = process.argv.slice(2);
if (paths.length < 2 || paths.length % 2 !== 0) {
  throw new Error(
    "Usage: compare-turn-predispatch.ts before.json after.json [before2.json after2.json]",
  );
}
const before: Measurement = { samples: [], continuationSamples: [] };
const after: Measurement = { samples: [], continuationSamples: [] };
for (let i = 0; i < paths.length; i++) {
  const data: Measurement = await Bun.file(paths[i]!).json();
  const target = i % 2 === 0 ? before : after;
  target.samples.push(...data.samples);
  target.continuationSamples.push(...data.continuationSamples);
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) throw new Error("Missing measurements");
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function summarize(samples: Sample[]) {
  if (samples.length < 20) throw new Error("At least 20 samples per scenario are required");
  const dispatchSamplesMs = samples.map((sample) => sample.providerDispatchMs);
  return {
    dispatchMs: distribution(dispatchSamplesMs),
    dispatchSamplesMs,
    statements: distribution(samples.map((sample) => sample.queries.length)),
    transactions: distribution(
      samples.map((sample) => sample.queries.filter((query) => /^begin\b/i.test(query)).length),
    ),
    savepoints: distribution(
      samples.map((sample) => sample.queries.filter((query) => /^savepoint\b/i.test(query)).length),
    ),
    atomicClaimStatements: distribution(
      samples.map((sample) => {
        const begin = sample.queries.findIndex((query) => /^begin\b/i.test(query));
        const commit = sample.queries.findIndex(
          (query, index) => index > begin && /^commit\b/i.test(query),
        );
        if (begin < 0 || commit < 0) throw new Error("Missing atomic claim transaction");
        return commit - begin + 1;
      }),
    ),
    phasesMs: Object.fromEntries(
      [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))]
        .sort()
        .map((phase) => [
          phase,
          distribution(samples.flatMap((sample) => sample.phases[phase] ?? [])),
        ]),
    ),
  };
}

function requestFingerprint(samples: Sample[]) {
  // The harness already normalizes UUIDs and ISO timestamps. Rendered message
  // headers and update delivery timestamps use this exact additional format.
  // Never sort keys, arrays, tools, schemas or messages to make requests match.
  const normalized = samples.map((sample) => {
    if (typeof sample.normalizedRequest !== "string")
      throw new Error("Missing ordered request capture");
    return sample.normalizedRequest.replace(
      /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g,
      "<display-timestamp>",
    );
  });
  if (new Set(normalized).size !== 1)
    throw new Error("Ordered model requests differ within or between revisions");
  return new Bun.CryptoHasher("sha256").update(normalized[0]!).digest("hex");
}

console.log(
  JSON.stringify(
    Object.fromEntries(
      (["samples", "continuationSamples"] as const).map((kind) => [
        kind,
        {
          before: summarize(before[kind]),
          after: summarize(after[kind]),
          identicalOrderedRequestSha256: requestFingerprint([...before[kind], ...after[kind]]),
        },
      ]),
    ),
    null,
    2,
  ),
);
