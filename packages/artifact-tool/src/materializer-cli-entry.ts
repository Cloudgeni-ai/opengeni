#!/usr/bin/env node

import { runArtifactMaterializerCli } from "./materializer-cli";

try {
  await runArtifactMaterializerCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code: "materializer_failed", message } })}\n`);
  process.exitCode = 1;
}
