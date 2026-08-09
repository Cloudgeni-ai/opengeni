#!/usr/bin/env bun

import { isAbsolute } from "node:path";
import { writeArtifactKernelBuildReceipt } from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  artifactRuntimeTarget,
  type ArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";

const targetValue = argument("--target") as ArtifactRuntimeTarget;
artifactRuntimeTarget(targetValue);
const assetRoot = argument("--asset-root");
if (!isAbsolute(assetRoot)) throw new Error("--asset-root must be absolute");
const path = await writeArtifactKernelBuildReceipt(targetValue, assetRoot);
process.stdout.write(`${JSON.stringify({ target: targetValue, receipt: path })}\n`);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}
