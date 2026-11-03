#!/usr/bin/env bun
/**
 * Published SDK route inventory (`scripts/public-api/published-sdk.gen.json`).
 *
 * The surface snapshot (`surface.gen.json`) guards the SDK in this repository.
 * Integrators install a *published* `@opengeni/sdk` and keep it pinned, so this
 * inventory records every `/v1` route that a published version calls,
 * extracted from the TypeScript source the package ships (`src/`) with the
 * same extractor the snapshot uses (`@internal` methods excluded).
 * `bun run check:public-api` then fails when the candidate API no longer
 * registers a route that a published SDK calls, unless the call is an
 * accepted gap recorded in the inventory or a security/owner-approved
 * exception in `breaking-changes.json`.
 *
 * Refresh after each stable SDK publication (defaults to npm `latest`):
 *
 *   bun run public-api:published-refresh                 # npm latest
 *   bun run public-api:published-refresh -- --version 6.7.0
 *
 * Refresh keeps every other recorded package version and the reasons of
 * existing accepted gaps. It refuses to record a new gap unless
 * `--accept-gaps "<reason>"` is passed; a new gap means a published SDK method
 * already fails against the API, which this policy does not allow.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractSdkMethods, matchRoutes, sdkSourceFiles } from "./surface";

export const PUBLISHED_SDK_PATH = "scripts/public-api/published-sdk.gen.json";
const PACKAGE_NAME = "@opengeni/sdk";

export type PublishedGap = { call: string; reason: string };

export type PublishedPackage = {
  name: string;
  version: string;
  /** `VERB[|VERB] /v1/normalized/:p/path` -> SDK methods that make the call. */
  calls: Record<string, string[]>;
  /** Calls the API already did not serve when this version was recorded. */
  acceptedGaps: PublishedGap[];
};

export type PublishedInventory = { schemaVersion: 1; packages: PublishedPackage[] };

type Route = { method: string; path: string };

/** Route calls made by the SDK whose `src/` directory is given. */
export function publishedSdkCalls(sourceDirectory: string): Record<string, string[]> {
  const methods = extractSdkMethods(sdkSourceFiles(sourceDirectory)).filter(
    (method) => !method.internal,
  );
  const calls = new Map<string, Set<string>>();
  for (const method of methods) {
    const verbs = method.verbs.size > 0 ? [...method.verbs].sort() : ["GET"];
    for (const path of method.paths) {
      // `${base}/...` helpers: a path that only prefixes the method's other
      // paths is a base URL, not a call (same rule as the surface snapshot).
      if ([...method.paths].some((other) => other.startsWith(`${path}/`))) continue;
      const key = `${verbs.join("|")} ${path}`;
      (calls.get(key) ?? calls.set(key, new Set()).get(key)!).add(method.name);
    }
  }
  return Object.fromEntries(
    [...calls.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, names]) => [key, [...names].sort()]),
  );
}

/** True when some verb of the call matches a registered route. */
export function callServed(call: string, registered: readonly Route[]): boolean {
  const space = call.indexOf(" ");
  const verbs = call.slice(0, space).split("|");
  const path = call.slice(space + 1);
  const v1 = registered.filter((route) => route.path.startsWith("/v1/"));
  return verbs.some((verb) => matchRoutes(path, verb, v1).length > 0);
}

export type PublishedFinding = { id: string; message: string };

/** Calls of published SDKs that the candidate API no longer serves. */
export function publishedSdkFindings(
  inventory: PublishedInventory,
  registered: readonly Route[],
): { breaking: PublishedFinding[]; resolvedGaps: string[] } {
  const breaking: PublishedFinding[] = [];
  const resolvedGaps: string[] = [];
  for (const pkg of inventory.packages) {
    const accepted = new Set(pkg.acceptedGaps.map((gap) => gap.call));
    for (const [call, methods] of Object.entries(pkg.calls)) {
      const served = callServed(call, registered);
      if (served) {
        if (accepted.has(call)) resolvedGaps.push(`${pkg.name}@${pkg.version}: ${call}`);
        continue;
      }
      if (accepted.has(call)) continue;
      breaking.push({
        id: `published-sdk:${pkg.name}@${pkg.version}:${call}`,
        message: `published ${pkg.name}@${pkg.version} calls ${call} (${methods.join(", ")}), which the API no longer registers`,
      });
    }
  }
  return { breaking, resolvedGaps };
}

export function validatePublishedInventory(value: unknown): PublishedInventory {
  const inventory = value as Partial<PublishedInventory>;
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.packages))
    throw new Error(`${PUBLISHED_SDK_PATH} must be { schemaVersion: 1, packages: [...] }`);
  for (const [index, pkg] of inventory.packages.entries()) {
    const where = `${PUBLISHED_SDK_PATH} packages[${index}]`;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
      throw new Error(`${where} needs a name and version`);
    if (typeof pkg.calls !== "object" || pkg.calls === null)
      throw new Error(`${where}.calls must be an object`);
    if (!Array.isArray(pkg.acceptedGaps)) throw new Error(`${where}.acceptedGaps must be an array`);
    for (const gap of pkg.acceptedGaps) {
      if (typeof gap.call !== "string" || !(gap.call in pkg.calls))
        throw new Error(`${where} accepted gap ${JSON.stringify(gap.call)} is not a recorded call`);
      if (typeof gap.reason !== "string" || gap.reason.trim().length < 10)
        throw new Error(`${where} accepted gap ${gap.call} must explain why it is accepted`);
    }
  }
  return inventory as PublishedInventory;
}

/** Recompute one package version's entry, preserving the reasons of known gaps. */
export function refreshPublishedPackage(input: {
  name: string;
  version: string;
  calls: Record<string, string[]>;
  registered: readonly Route[];
  previous: PublishedPackage | undefined;
  acceptGapsReason: string | null;
}): { entry: PublishedPackage; newGaps: string[] } {
  const known = new Map((input.previous?.acceptedGaps ?? []).map((gap) => [gap.call, gap.reason]));
  const acceptedGaps: PublishedGap[] = [];
  const newGaps: string[] = [];
  for (const call of Object.keys(input.calls)) {
    if (callServed(call, input.registered)) continue;
    const reason = known.get(call);
    if (reason) acceptedGaps.push({ call, reason });
    else {
      newGaps.push(call);
      if (input.acceptGapsReason) acceptedGaps.push({ call, reason: input.acceptGapsReason });
    }
  }
  return {
    entry: { name: input.name, version: input.version, calls: input.calls, acceptedGaps },
    newGaps,
  };
}

function npm(args: string[], cwd?: string): string {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function refresh(): Promise<void> {
  const root = resolve(import.meta.dir, "..", "..");
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? null) : null;
  };
  const version = option("--version") ?? npm(["view", PACKAGE_NAME, "dist-tags.latest"]).trim();
  const acceptGapsReason = option("--accept-gaps");
  const directory = mkdtempSync(join(tmpdir(), "opengeni-published-sdk-"));
  try {
    const tarball = npm(
      ["pack", `${PACKAGE_NAME}@${version}`, "--silent", "--pack-destination", directory],
      directory,
    )
      .trim()
      .split("\n")
      .at(-1)!;
    execFileSync("tar", ["xzf", join(directory, tarball), "-C", directory]);
    const source = join(directory, "package", "src");
    if (!existsSync(source))
      throw new Error(`${PACKAGE_NAME}@${version} does not ship src/; cannot extract its calls`);
    const calls = publishedSdkCalls(source);
    const { registeredRoutes } = await import("./registered-routes");
    const file = join(root, PUBLISHED_SDK_PATH);
    const inventory: PublishedInventory = existsSync(file)
      ? validatePublishedInventory(JSON.parse(readFileSync(file, "utf8")))
      : { schemaVersion: 1, packages: [] };
    const previous = inventory.packages.find(
      (pkg) => pkg.name === PACKAGE_NAME && pkg.version === version,
    );
    const { entry, newGaps } = refreshPublishedPackage({
      name: PACKAGE_NAME,
      version,
      calls,
      registered: registeredRoutes(),
      previous,
      acceptGapsReason,
    });
    if (newGaps.length > 0 && !acceptGapsReason) {
      process.stderr.write(
        `[published-sdk] ${PACKAGE_NAME}@${version} calls ${newGaps.length} route(s) the API does not register:\n${newGaps
          .map((call) => `  ${call} (${calls[call]!.join(", ")})`)
          .join(
            "\n",
          )}\nRestore those routes, or pass --accept-gaps "<reason>" only for an approved exception.\n`,
      );
      process.exit(1);
    }
    const packages = inventory.packages.filter(
      (pkg) => !(pkg.name === PACKAGE_NAME && pkg.version === version),
    );
    packages.push(entry);
    packages.sort((a, b) =>
      a.name === b.name ? Bun.semver.order(a.version, b.version) : a.name.localeCompare(b.name),
    );
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`);
    process.stdout.write(
      `[published-sdk] recorded ${PACKAGE_NAME}@${version}: ${Object.keys(calls).length} calls, ${entry.acceptedGaps.length} accepted gaps\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await refresh();
