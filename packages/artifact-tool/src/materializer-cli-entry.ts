#!/usr/bin/env node

import { runArtifactMaterializerCli } from "./materializer-cli";
import { errorMessage } from "@opengeni/contracts/values";

try {
  await runArtifactMaterializerCli(process.argv.slice(2));
} catch (error) {
  const message = errorMessage(error);
  process.stderr.write(`${JSON.stringify({ error: { code: "materializer_failed", message } })}\n`);
  process.exitCode = 1;
}
