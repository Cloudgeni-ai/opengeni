#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAMEWORK_SESSION_ADVERSARIAL_SEEDS,
  runFrameworkSessionAdversarialCorpus,
} from "./framework-session-adversarial-lib";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(
  argument("--output") ??
    `${repoRoot}/.agent/evidence/framework-ui/development/adversarial/report.json`,
);
const report = runFrameworkSessionAdversarialCorpus(FRAMEWORK_SESSION_ADVERSARIAL_SEEDS);
if (report.faultProbes.some(({ detected }) => !detected)) {
  throw new Error("one or more framework-session fault probes produced a false PASS");
}
if (
  report.seeds.some(({ finalResources }) =>
    Object.values(finalResources).some((value) => value !== 0),
  )
) {
  throw new Error("one or more framework-session seeds leaked a final resource");
}
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(
    {
      ...report,
      environment: {
        generatedAt: new Date().toISOString(),
        bun: Bun.version,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `[framework-session-adversarial] PASS seeds=${report.seeds.map(({ seedHex }) => seedHex).join(",")} faultProbes=${report.faultProbes.length} evidence=${output}\n`,
);

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
