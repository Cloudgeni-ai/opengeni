#!/usr/bin/env bun
// Writes packages/contracts/src/child-lifecycle-notice-protocol.gen.json, or
// with --check fails when the committed file differs from the source schemas.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderChildLifecycleNoticeProtocol } from "../packages/contracts/src/child-lifecycle-notice-protocol";

const target = fileURLToPath(
  new URL("../packages/contracts/src/child-lifecycle-notice-protocol.gen.json", import.meta.url),
);
const rendered = renderChildLifecycleNoticeProtocol();

if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8").catch(() => "");
  if (committed !== rendered) {
    console.error(
      "child-lifecycle-notice-protocol.gen.json is stale; run bun scripts/generate-child-lifecycle-notice-protocol.ts",
    );
    process.exit(1);
  }
} else {
  await writeFile(target, rendered);
}
