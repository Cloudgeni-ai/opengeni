#!/usr/bin/env node

import { ArtifactRuntimeError } from "./runtime";
import { runConfiguredArtifactRuntimeCli } from "./runtime-development";

try {
  process.stdout.write(await runConfiguredArtifactRuntimeCli(process.argv.slice(2)));
} catch (error) {
  const code = error instanceof ArtifactRuntimeError ? error.code : "ARTIFACT_RUNTIME_UNAVAILABLE";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
}
