#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { bundleWorkflowCode } from "@temporalio/worker";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsPath = resolve(packageRoot, "src/workflows.ts");
const outputPath = resolve(packageRoot, "dist/workflow-bundle.js");

const bundle = await bundleWorkflowCode({ workflowsPath });
if (!bundle.code.trim()) {
  throw new Error("Temporal produced an empty OpenGeni workflow bundle");
}

// Parse before writing so a release can never carry an artifact that V8 cannot load.
new Script(bundle.code, { filename: outputPath }).createCachedData();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bundle.code, { encoding: "utf8", mode: 0o644 });

process.stdout.write(
  `[worker-bundle] wrote ${outputPath} (${Buffer.byteLength(bundle.code, "utf8")} bytes)\n`,
);
