#!/usr/bin/env bun
// Writes packages/cli/schemas/agent.schema.json (the JSON Schema of an
// Opengeni agent file, agents/<key>.yaml) from the OrgAgentFile contract, or
// with --check fails when the committed file differs.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { orgAgentFileJsonSchema } from "../packages/contracts/src/organization-agents";

const target = fileURLToPath(new URL("../packages/cli/schemas/agent.schema.json", import.meta.url));
const rendered = `${JSON.stringify(orgAgentFileJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8").catch(() => "");
  if (committed !== rendered) {
    console.error(
      "packages/cli/schemas/agent.schema.json is stale; run bun scripts/generate-agent-file-schema.ts",
    );
    process.exit(1);
  }
} else {
  await writeFile(target, rendered);
}
