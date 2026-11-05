#!/usr/bin/env bun
/**
 * Keep the Grok client version Opengeni presents to xAI on the current Grok
 * CLI stable release.
 *
 * xAI refuses subscription requests from Grok CLI versions below its minimum.
 * The transport adopts a higher minimum named by such a refusal at runtime,
 * but the pinned version should not lag: this script reads the stable channel
 * pointer the official installer uses and rewrites the pin.
 *
 *   bun scripts/xai-client-version-pin.ts            rewrite the pin when a newer release exists
 *   bun scripts/xai-client-version-pin.ts --check    exit 1 when a newer release exists
 *   bun scripts/xai-client-version-pin.ts --describe print the pinned version
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const XAI_CONSTANTS_FILE = "packages/xai-subscription/src/constants.ts";
export const GROK_CLI_STABLE_POINTERS = [
  "https://x.ai/cli/stable",
  "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
] as const;

const PIN = /export const XAI_CLIENT_VERSION = "(\d+\.\d+\.\d+)";/;
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export function readPinnedXaiClientVersion(source: string): string {
  const match = PIN.exec(source);
  if (!match) throw new Error(`${XAI_CONSTANTS_FILE} has no XAI_CLIENT_VERSION pin`);
  return match[1]!;
}

export function rewriteXaiClientVersion(source: string, version: string): string {
  readPinnedXaiClientVersion(source);
  return source.replace(PIN, `export const XAI_CLIENT_VERSION = "${version}";`);
}

/** The stable pointer is one bare X.Y.Z line; anything else is rejected. */
export function parseStablePointer(body: string): string | null {
  const version = body.replace(/\r/g, "").split("\n")[0]?.trim() ?? "";
  return SEMVER.test(version) ? version : null;
}

export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) throw new Error(`Invalid version: ${a ? right : left}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function fetchStableVersion(): Promise<string> {
  const failures: string[] = [];
  for (const url of GROK_CLI_STABLE_POINTERS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const version = parseStablePointer(await response.text());
      if (version) return version;
      failures.push(`${url}: not a version`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not read the Grok CLI stable release (${failures.join("; ")})`);
}

async function main(): Promise<void> {
  const path = resolve(ROOT, XAI_CONSTANTS_FILE);
  const source = await readFile(path, "utf8");
  const pinned = readPinnedXaiClientVersion(source);
  if (process.argv.includes("--describe")) {
    console.log(`Grok client version: ${pinned}`);
    return;
  }
  const stable = await fetchStableVersion();
  if (compareVersions(stable, pinned) <= 0) {
    console.log(`Grok client version ${pinned} is current (stable ${stable}).`);
    return;
  }
  if (process.argv.includes("--check")) {
    console.error(`Grok client version ${pinned} is behind the stable release ${stable}.`);
    process.exit(1);
  }
  await writeFile(path, rewriteXaiClientVersion(source, stable));
  console.log(`Grok client version ${pinned} -> ${stable}.`);
}

if (import.meta.main) {
  await main();
}
