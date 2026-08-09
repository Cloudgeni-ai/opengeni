#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const nativePath = process.env.OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH;
if (!nativePath || !isAbsolute(nativePath) || !existsSync(nativePath)) {
  throw new Error(
    "OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH must name an existing absolute native addon",
  );
}

const tests = [
  "document-skill-conformance.test.ts",
  "skill-conformance.test.ts",
  "production-native.test.ts",
  "materializer-cli.test.ts",
].map((name) => resolve(repoRoot, "packages", "artifact-tool", "test", name));
const child = Bun.spawn([process.execPath, "test", "--timeout", "120000", ...tests], {
  cwd: repoRoot,
  env: {
    ...process.env,
    OPENGENI_REQUIRE_ARTIFACT_NATIVE_TESTS: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
