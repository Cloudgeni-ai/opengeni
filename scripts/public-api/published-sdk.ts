#!/usr/bin/env bun
/**
 * Published SDK route inventory (`scripts/public-api/published-sdk.gen.json`).
 *
 * The surface snapshot (`surface.gen.json`) guards the SDK in this repository.
 * Integrators install a *published* `@opengeni/sdk` and keep it pinned, so this
 * inventory records the `/v1` route calls a published version makes, extracted
 * from the TypeScript source the package ships (`src/`) with the same
 * extractor the snapshot uses (`@internal` methods excluded).
 *
 * At refresh time each call is resolved to the exact registered routes
 * (`METHOD /path`) that serve it, and those routes are stored. The check then
 * requires every stored route to remain registered, exactly. A call that no
 * registered route served when its version was recorded is an accepted gap
 * with a reason.
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
 *
 * A generic call (no literal segment after its first placeholder, such as
 * `${base}/${area}/${id}`) never resolves loosely: it would pin every route of
 * that shape, including web-only ones. Pin its real routes by hand in the
 * package's `routeOverrides` with a reason; refresh keeps them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractSdkMethods, matchQuality, sdkSourceFiles } from "./surface";

export const PUBLISHED_SDK_PATH = "scripts/public-api/published-sdk.gen.json";
const PACKAGE_NAME = "@opengeni/sdk";

export type PublishedGap = { call: string; reason: string };

/** Hand-pinned routes for a call the resolver cannot resolve precisely. */
export type PublishedRouteOverride = { call: string; routes: string[]; reason: string };

export type PublishedCall = {
  /** SDK methods that make the call. */
  sdk: string[];
  /** Exact registered routes (`METHOD /path`) that served the call when recorded. */
  routes: string[];
};

export type PublishedPackage = {
  name: string;
  version: string;
  /** `VERB[|VERB] /v1/normalized/:p/path` -> the call's methods and resolved routes. */
  calls: Record<string, PublishedCall>;
  /** Calls no registered route served when this version was recorded. */
  acceptedGaps: PublishedGap[];
  /** Calls whose routes are pinned by hand instead of resolved. */
  routeOverrides?: PublishedRouteOverride[];
};

export type PublishedInventory = { schemaVersion: 2; packages: PublishedPackage[] };

type Route = { method: string; path: string };

/** Route calls (`VERB[|VERB] path` -> SDK methods) made by the SDK whose `src/` is given. */
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

/**
 * Whether every literal segment the SDK wrote lines up with a literal route
 * segment. A loose match (an SDK placeholder standing in for a route literal,
 * as in `company-brain/${kind}`) only counts when it is structural like this;
 * otherwise an unrelated route that happens to have the same length (for
 * example `/v1/workspaces/external/:source/:id/allowance`) would "serve" a
 * removed call. It also needs a literal after the SDK's first placeholder, so
 * a generic `/v1/workspaces/:p/:p/:p` does not pin every route of that shape.
 */
function literalsAlign(sdkPath: string, routePath: string): boolean {
  const sdk = sdkPath.split("/");
  const route = routePath.split("/");
  const firstPlaceholder = sdk.findIndex((segment) => segment.includes(":p"));
  if (
    firstPlaceholder >= 0 &&
    !sdk.slice(firstPlaceholder + 1).some((segment) => segment !== "" && !segment.includes(":p"))
  )
    return false;
  for (let index = 0; index < sdk.length; index += 1) {
    const segment = route[index];
    if (segment === "*") return true;
    if (sdk[index]!.includes(":p")) continue;
    if (segment === undefined || segment.startsWith(":")) return false;
  }
  return true;
}

/** The exact registered routes (`METHOD /path`) that serve a call, sorted. */
export function resolveCall(call: string, registered: readonly Route[]): string[] {
  const space = call.indexOf(" ");
  const verbs = call.slice(0, space).split("|");
  const path = call.slice(space + 1);
  const resolved = new Set<string>();
  for (const verb of verbs) {
    const candidates = registered
      .filter((route) => route.method === verb && route.path.startsWith("/v1/"))
      .map((route) => ({ route, quality: matchQuality(path, route.path) }))
      .filter((entry) => entry.quality > 0);
    const exact = candidates.filter((entry) => entry.quality === 2);
    const chosen =
      exact.length > 0
        ? exact
        : candidates.filter((entry) => literalsAlign(path, entry.route.path));
    for (const { route } of chosen) resolved.add(`${route.method} ${route.path}`);
  }
  return [...resolved].sort();
}

export type PublishedFinding = { id: string; message: string };

/** Routes recorded for published SDKs that the candidate API no longer registers. */
export function publishedSdkFindings(
  inventory: PublishedInventory,
  registered: readonly Route[],
): { breaking: PublishedFinding[]; resolvedGaps: string[] } {
  const available = new Set(registered.map((route) => `${route.method} ${route.path}`));
  const breaking: PublishedFinding[] = [];
  const resolvedGaps: string[] = [];
  for (const pkg of inventory.packages) {
    const reported = new Set<string>();
    for (const [call, entry] of Object.entries(pkg.calls)) {
      for (const route of entry.routes) {
        if (available.has(route) || reported.has(route)) continue;
        reported.add(route);
        const callers = Object.entries(pkg.calls)
          .filter(([, other]) => other.routes.includes(route))
          .flatMap(([, other]) => other.sdk);
        breaking.push({
          id: `published-sdk:${pkg.name}@${pkg.version}:${route}`,
          message: `published ${pkg.name}@${pkg.version} calls ${route} (${[...new Set(callers)].sort().join(", ")}), which the API no longer registers`,
        });
      }
      if (entry.routes.length === 0 && resolveCall(call, registered).length > 0)
        resolvedGaps.push(`${pkg.name}@${pkg.version}: ${call}`);
    }
  }
  return { breaking, resolvedGaps };
}

export function validatePublishedInventory(value: unknown): PublishedInventory {
  const inventory = value as Partial<PublishedInventory>;
  if (inventory?.schemaVersion !== 2 || !Array.isArray(inventory.packages))
    throw new Error(`${PUBLISHED_SDK_PATH} must be { schemaVersion: 2, packages: [...] }`);
  for (const [index, pkg] of inventory.packages.entries()) {
    const where = `${PUBLISHED_SDK_PATH} packages[${index}]`;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
      throw new Error(`${where} needs a name and version`);
    if (typeof pkg.calls !== "object" || pkg.calls === null)
      throw new Error(`${where}.calls must be an object`);
    if (!Array.isArray(pkg.acceptedGaps)) throw new Error(`${where}.acceptedGaps must be an array`);
    if (pkg.routeOverrides !== undefined && !Array.isArray(pkg.routeOverrides))
      throw new Error(`${where}.routeOverrides must be an array`);
    for (const override of pkg.routeOverrides ?? []) {
      const recorded = typeof override.call === "string" ? pkg.calls[override.call] : undefined;
      if (!recorded)
        throw new Error(
          `${where} route override ${JSON.stringify(override.call)} is not a recorded call`,
        );
      if (typeof override.reason !== "string" || override.reason.trim().length < 10)
        throw new Error(`${where} route override ${override.call} must explain the pinned routes`);
      if (
        !Array.isArray(override.routes) ||
        override.routes.length === 0 ||
        JSON.stringify([...override.routes].sort()) !== JSON.stringify(recorded.routes)
      )
        throw new Error(
          `${where} route override ${override.call} must list the call's recorded routes`,
        );
    }
    const gaps = new Set<string>();
    for (const gap of pkg.acceptedGaps) {
      if (typeof gap.call !== "string" || !(gap.call in pkg.calls))
        throw new Error(`${where} accepted gap ${JSON.stringify(gap.call)} is not a recorded call`);
      if (typeof gap.reason !== "string" || gap.reason.trim().length < 10)
        throw new Error(`${where} accepted gap ${gap.call} must explain why it is accepted`);
      gaps.add(gap.call);
    }
    for (const [call, entry] of Object.entries(pkg.calls)) {
      if (!Array.isArray(entry?.sdk) || !Array.isArray(entry?.routes))
        throw new Error(`${where} call ${call} needs sdk and routes arrays`);
      if (entry.routes.length === 0 && !gaps.has(call))
        throw new Error(`${where} call ${call} resolves to no route and is not an accepted gap`);
      if (entry.routes.length > 0 && gaps.has(call))
        throw new Error(`${where} accepted gap ${call} resolves to routes; remove the gap`);
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
  const overrides = (input.previous?.routeOverrides ?? []).filter(
    (override) => override.call in input.calls,
  );
  const pinned = new Map(overrides.map((override) => [override.call, override.routes]));
  const calls: Record<string, PublishedCall> = {};
  const acceptedGaps: PublishedGap[] = [];
  const newGaps: string[] = [];
  for (const [call, sdk] of Object.entries(input.calls)) {
    const routes = [...(pinned.get(call) ?? resolveCall(call, input.registered))].sort();
    calls[call] = { sdk, routes };
    if (routes.length > 0) continue;
    const reason = known.get(call);
    if (reason) acceptedGaps.push({ call, reason });
    else {
      newGaps.push(call);
      if (input.acceptGapsReason) acceptedGaps.push({ call, reason: input.acceptGapsReason });
    }
  }
  return {
    entry: {
      name: input.name,
      version: input.version,
      calls,
      acceptedGaps,
      ...(overrides.length > 0 ? { routeOverrides: overrides } : {}),
    },
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
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    // Not validated here: a hand-added route override is only consistent after
    // refresh applies it. The result is validated below.
    const packages: PublishedPackage[] =
      existing?.schemaVersion === 2 && Array.isArray(existing.packages) ? existing.packages : [];
    const previous =
      packages.find((pkg) => pkg.name === PACKAGE_NAME && pkg.version === version) ??
      // Gap reasons from an older inventory format stay valid for the same version.
      (existing?.packages as PublishedPackage[] | undefined)?.find(
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
    const next = packages.filter((pkg) => !(pkg.name === PACKAGE_NAME && pkg.version === version));
    next.push(entry);
    next.sort((a, b) =>
      a.name === b.name ? Bun.semver.order(a.version, b.version) : a.name.localeCompare(b.name),
    );
    const inventory = validatePublishedInventory({ schemaVersion: 2, packages: next });
    writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(
      `[published-sdk] recorded ${PACKAGE_NAME}@${version}: ${Object.keys(calls).length} calls, ${entry.acceptedGaps.length} accepted gaps\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await refresh();
