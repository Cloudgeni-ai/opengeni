import { readFile } from "node:fs/promises";

import { verifyDensityProfileArtifactText } from "./turn-density-profile";

function usage(): never {
  throw new Error(
    "Usage: bun run verify:turn-density -- <artifact.json> [--sha256 <expected-sha256>]",
  );
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const path = args.shift();
  if (!path) usage();
  let expectedSha256: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== "--sha256" || expectedSha256 !== undefined) usage();
    expectedSha256 = args.shift();
    if (!expectedSha256) usage();
  }
  const text = await readFile(path, "utf8");
  const report = verifyDensityProfileArtifactText(text, expectedSha256);
  console.log(`OPENGENI_DENSITY_VERIFICATION=${JSON.stringify(report)}`);
}

if (import.meta.main) await main();
