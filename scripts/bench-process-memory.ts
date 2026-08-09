#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Role = "control" | "turn";
type Sample = { profile: string; rssMiB: number };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = 3;
const childProgram = String.raw`
const target = process.env.OPENGENI_BENCH_IMPORT;
const role = process.env.OPENGENI_BENCH_ROLE;
if (!target) throw new Error("missing benchmark import");
const module = await import(target);
if (role) await module.createDefaultWorkerActivities(role, {});
Bun.gc(true);
await Bun.sleep(20);
process.stdout.write(JSON.stringify({ rssMiB: +(process.memoryUsage.rss() / 1048576).toFixed(1) }));
`;

const profiles: Array<{ profile: string; path: string; role?: Role; smol?: boolean }> = [
  { profile: "api-source", path: "apps/api/src/index.ts" },
  { profile: "api-bundle", path: "apps/api/dist/process/index.js" },
  { profile: "api-bundle-smol", path: "apps/api/dist/process/index.js", smol: true },
  { profile: "worker-control-source", path: "apps/worker/src/index.ts", role: "control" },
  { profile: "worker-control-bundle", path: "apps/worker/dist/process/index.js", role: "control" },
  {
    profile: "worker-control-bundle-smol",
    path: "apps/worker/dist/process/index.js",
    role: "control",
    smol: true,
  },
  { profile: "worker-turn-source", path: "apps/worker/src/index.ts", role: "turn" },
  { profile: "worker-turn-bundle", path: "apps/worker/dist/process/index.js", role: "turn" },
  {
    profile: "worker-turn-bundle-smol",
    path: "apps/worker/dist/process/index.js",
    role: "turn",
    smol: true,
  },
  {
    profile: "artifact-materializer-source",
    path: "apps/worker/src/artifact-materializer-entry.ts",
  },
  {
    profile: "artifact-materializer-bundle",
    path: "apps/worker/dist/process/artifact-materializer/artifact-materializer-entry.js",
  },
  {
    profile: "artifact-materializer-bundle-smol",
    path: "apps/worker/dist/process/artifact-materializer/artifact-materializer-entry.js",
    smol: true,
  },
  {
    profile: "artifact-outbox-source",
    path: "apps/worker/src/artifact-outbox-entry.ts",
  },
  {
    profile: "artifact-outbox-bundle",
    path: "apps/worker/dist/process/artifact-outbox/artifact-outbox-entry.js",
  },
  {
    profile: "artifact-outbox-bundle-smol",
    path: "apps/worker/dist/process/artifact-outbox/artifact-outbox-entry.js",
    smol: true,
  },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function sample(profile: (typeof profiles)[number]): Promise<Sample> {
  const absolute = resolve(root, profile.path);
  if (!existsSync(absolute)) {
    throw new Error(`Missing ${profile.path}; run bun run build:runtime-processes first`);
  }
  const child = Bun.spawn({
    cmd: ["bun", ...(profile.smol ? ["--smol"] : []), "-e", childProgram],
    cwd: root,
    env: {
      ...process.env,
      OPENGENI_BENCH_IMPORT: pathToFileURL(absolute).href,
      ...(profile.role ? { OPENGENI_BENCH_ROLE: profile.role } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${profile.profile} child failed`);
  const result = JSON.parse(stdout) as { rssMiB: number };
  return { profile: profile.profile, rssMiB: result.rssMiB };
}

const samples = new Map<string, number[]>();
for (const profile of profiles) {
  for (let run = 0; run < runs; run += 1) {
    const result = await sample(profile);
    const values = samples.get(result.profile) ?? [];
    values.push(result.rssMiB);
    samples.set(result.profile, values);
  }
}

const medians = Object.fromEntries(
  [...samples.entries()].map(([profile, values]) => [profile, median(values)]),
) as Record<string, number>;
const comparisons = [
  "api",
  "worker-control",
  "worker-turn",
  "artifact-materializer",
  "artifact-outbox",
].map((profile) => {
  const sourceMiB = medians[`${profile}-source`]!;
  const bundleMiB = medians[`${profile}-bundle`]!;
  const smolBundleMiB = medians[`${profile}-bundle-smol`]!;
  return {
    profile,
    sourceMiB,
    bundleMiB,
    smolBundleMiB,
    savedMiB: +(sourceMiB - bundleMiB).toFixed(1),
    reduction: +((1 - bundleMiB / sourceMiB) * 100).toFixed(1),
  };
});

process.stdout.write(
  `${JSON.stringify({ runs, comparisons, samples: Object.fromEntries(samples) }, null, 2)}\n`,
);

if (process.argv.includes("--check")) {
  const failed = comparisons.filter((result) => result.bundleMiB > result.sourceMiB * 0.85);
  if (failed.length > 0) {
    throw new Error(
      `Runtime bundles missed the 15% RSS reduction floor: ${failed.map((item) => item.profile).join(", ")}`,
    );
  }
}
