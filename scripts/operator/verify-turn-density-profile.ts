import { readFile } from "node:fs/promises";

import { verifyDensityProfileArtifactText } from "./turn-density-profile";

function usage(): never {
  throw new Error(
    "Usage: bun run verify:turn-density -- <artifact.json> --production-revision <revision> [--sha256 <expected-sha256>] [--allow-noncanonical]",
  );
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const path = args.shift();
  if (!path) usage();
  let expectedSha256: string | undefined;
  let expectedProductionRevision: string | undefined;
  let allowNoncanonical = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--sha256" && expectedSha256 === undefined) {
      expectedSha256 = args.shift();
      if (!expectedSha256) usage();
    } else if (flag === "--production-revision" && expectedProductionRevision === undefined) {
      expectedProductionRevision = args.shift();
      if (!expectedProductionRevision) usage();
    } else if (flag === "--allow-noncanonical" && !allowNoncanonical) {
      allowNoncanonical = true;
    } else {
      usage();
    }
  }
  const text = await readFile(path, "utf8");
  const report = verifyDensityProfileArtifactText(text, expectedSha256, {
    expectedProductionRevision,
    allowNoncanonical,
  });
  console.log(`OPENGENI_DENSITY_VERIFICATION=${JSON.stringify(report)}`);
}

if (import.meta.main) await main();
