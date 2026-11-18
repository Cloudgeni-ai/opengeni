import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SELF_SERVE_ACCOUNT_SOURCES } from "../src/index";

// resolveSandboxPlanTier treats an organization whose managed account has an
// external source outside SELF_SERVE_ACCOUNT_SOURCES as host-provisioned
// (`embedded`, unbounded). A new self-serve signup or organization-creation
// path with a new source would silently become unbounded, so every literal
// account source the code and migrations create must be classified here.

const KNOWN_HOST_ACCOUNT_SOURCES = new Set([
  // Local and configured (self-hosted or embedded-token) deployments.
  "opengeni:local",
  "opengeni:configured",
  // Benchmark fixtures.
  "bench",
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function files(directory: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...files(path, suffix));
    else if (name.endsWith(suffix)) out.push(path);
  }
  return out;
}

function accountSources(): Set<string> {
  const sources = new Set<string>();
  for (const path of files(join(root, "packages", "db", "drizzle"), ".sql")) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(
      /INSERT INTO managed_accounts\s*\([^)]*external_source[^)]*\)\s*VALUES\s*\(([^;]*?)\)\s*(?:RETURNING|ON|;)/gi,
    )) {
      for (const literal of match[1]!.matchAll(/'([a-z][a-z0-9-]*:[a-z0-9:-]+)'/gi)) {
        sources.add(literal[1]!);
      }
    }
  }
  for (const base of ["apps", "packages"]) {
    for (const path of files(join(root, base), ".ts")) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/accountExternalSource:\s*"([^"]+)"/g)) {
        sources.add(match[1]!);
      }
      for (const match of text.matchAll(
        /\.insert\(schema\.managedAccounts\)\s*\.values\(\{[^}]*externalSource:\s*"([^"]+)"/g,
      )) {
        sources.add(match[1]!);
      }
    }
  }
  return sources;
}

describe("plan tier account sources", () => {
  test("every account source the code creates is classified as self-serve or host", () => {
    const sources = accountSources();
    // The scan finds the known paths (signup, additional organization,
    // local and configured deployments).
    for (const expected of [
      "better-auth:user",
      "opengeni:additional-organization",
      "opengeni:local",
      "opengeni:configured",
    ]) {
      expect(sources.has(expected)).toBe(true);
    }
    const unclassified = [...sources].filter(
      (source) =>
        !SELF_SERVE_ACCOUNT_SOURCES.includes(source) && !KNOWN_HOST_ACCOUNT_SOURCES.has(source),
    );
    expect(unclassified).toEqual([]);
  });
});
