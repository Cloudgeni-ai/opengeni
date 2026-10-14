/**
 * Version automation step: keep the committed public API snapshot's `sdkMajor`
 * equal to the lockstep SDK major after `changeset version`.
 *
 * A Version PR that cuts a new major otherwise fails the public-api guard as a
 * stale snapshot, and Version PR CI regenerates the tree exactly, so the field
 * must be produced by the automation itself. Only that one line changes; the
 * routes, schemas and formatting are left byte-for-byte as committed.
 *
 * Usage (part of `bun run changeset:version`):
 *   bun scripts/public-api/refresh-sdk-major.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SDK_MAJOR_LINE = /^ {2}"sdkMajor": \d+,$/mu;

export function refreshSdkMajor(snapshotText: string, sdkVersion: string): string {
  const major = Number(sdkVersion.split(".")[0]);
  if (!Number.isInteger(major) || major < 0) {
    throw new TypeError(`invalid SDK version ${JSON.stringify(sdkVersion)}`);
  }
  if (!SDK_MAJOR_LINE.test(snapshotText)) {
    throw new TypeError("public API snapshot has no top-level sdkMajor line");
  }
  return snapshotText.replace(SDK_MAJOR_LINE, `  "sdkMajor": ${major},`);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const snapshotPath = join(root, "scripts/public-api/surface.gen.json");
  const sdkVersion = (
    JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const current = readFileSync(snapshotPath, "utf8");
  const next = refreshSdkMajor(current, sdkVersion);
  if (next !== current) writeFileSync(snapshotPath, next);
}
