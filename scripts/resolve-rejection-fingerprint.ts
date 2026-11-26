#!/usr/bin/env bun
/**
 * Resolve a log message fingerprint (m_<10 hex>) back to the source string
 * literal(s) that produce it: the API's `rejectionFingerprint` and the sandbox
 * reaper's `causeFingerprint`. Logs carry only the one-way hash of a message
 * (packages/observability/src/message-fingerprint.ts), so diagnosing a refusal
 * or reaper failure from logs never needs the message text itself.
 *
 *   bun run scripts/resolve-rejection-fingerprint.ts m_1a2b3c4d5e [more...]
 *
 * Messages built from template literals with interpolations resolve only when
 * every interpolated value was a number, identifier, or quoted value that the
 * normalizer removes; otherwise the fingerprint still groups identical refusals.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { messageFingerprint } from "../packages/observability/src/message-fingerprint";

const ROOT = join(import.meta.dir, "..");
const SOURCE_ROOTS = [
  "apps/api/src",
  "apps/worker/src",
  "packages/core/src",
  "packages/db/src",
  "packages/runtime/src",
];
const wanted = new Set(process.argv.slice(2).filter((value) => /^m_[0-9a-f]{10}$/.test(value)));
if (wanted.size === 0) {
  console.error("usage: bun run scripts/resolve-rejection-fingerprint.ts m_<10 hex> [...]");
  process.exit(2);
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path;
  }
}

const literal = /"((?:[^"\\\n]|\\.){3,512})"|'((?:[^'\\\n]|\\.){3,512})'|`([^`$]{3,512})`/g;
let found = 0;
for (const root of SOURCE_ROOTS) {
  for await (const file of sourceFiles(join(ROOT, root))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(literal)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      const fingerprint = messageFingerprint(value);
      if (!wanted.has(fingerprint)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      console.log(`${fingerprint}  ${relative(ROOT, file)}:${line}  ${JSON.stringify(value)}`);
      found += 1;
    }
  }
}
if (found === 0) console.error("No literal matched; the message is likely interpolated.");
