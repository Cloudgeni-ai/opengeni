// Extension and agent compatibility. bridge-compat.json lists every protocol
// an installed extension may use to reach the machine agent. Chrome updates an
// extension on its own schedule, and people update their agent on theirs, so
// for a while after a release both old and new extensions are installed next
// to both old and new agents:
// - a new agent keeps supporting every protocol that is not retired (the
//   agent's tests read this file), so it never strands an installed extension;
// - a store release waits until a released agent supports its protocol, so a
//   new extension never strands an installed agent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ExtensionBuild = "opengeni" | "branded";
/** `shared`: the host name every Opengeni Browser build uses.
 * `per-extension`: the host name plus the calling extension's ID. */
export type NativeHostScheme = "shared" | "per-extension";

export interface BridgeProtocol {
  id: string;
  build: ExtensionBuild;
  bridgeProtocolVersion: number;
  nativeHost: NativeHostScheme;
  /** The first agent release that supports this protocol. */
  minimumAgent: string;
  /** When the first extension using this protocol was released from main. */
  releasedOn: string;
  retiredOn?: string;
  /** The protocol that replaced this one, for the same build. */
  retiredBy?: string;
  /** Retired before this record existed; only the entries listed in
   * RETIRED_BEFORE_THIS_RULE may say so. */
  retiredBeforeThisRule?: boolean;
}

export interface BridgeCompat {
  protocols: BridgeProtocol[];
}

/** Installed extensions update over days to weeks: Chrome checks for updates
 * every few hours but applies them only when the extension's worker stops,
 * and the store's review comes first. */
export const RETIREMENT_DAYS = 60;
const RETIRED_BEFORE_THIS_RULE = new Set(["branded-shared-host-v1"]);
const NATIVE_HOST_NAME = "ai.opengeni.browser";
const DAY_MS = 24 * 60 * 60 * 1000;

export const BRIDGE_COMPAT_PATH = resolve(import.meta.dir, "../bridge-compat.json");

export function readBridgeCompat(path = BRIDGE_COMPAT_PATH): BridgeCompat {
  return JSON.parse(readFileSync(path, "utf8")) as BridgeCompat;
}

export function nativeHostScheme(hostName: string, extensionId: string): NativeHostScheme | null {
  if (hostName === NATIVE_HOST_NAME) return "shared";
  if (hostName === `${NATIVE_HOST_NAME}.${extensionId}`) return "per-extension";
  return null;
}

function day(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

function versionParts(version: string): number[] | null {
  return /^\d+\.\d+\.\d+$/u.test(version) ? version.split(".").map(Number) : null;
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error(`Not a release version: ${a ? right : left}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** Everything wrong with the record; empty when it is valid. */
export function bridgeCompatProblems(compat: BridgeCompat): string[] {
  const problems: string[] = [];
  const byId = new Map<string, BridgeProtocol>();
  for (const protocol of compat.protocols) {
    if (byId.has(protocol.id)) problems.push(`${protocol.id} is listed twice`);
    byId.set(protocol.id, protocol);
    if (protocol.build !== "opengeni" && protocol.build !== "branded")
      problems.push(`${protocol.id} has an unknown build ${String(protocol.build)}`);
    if (protocol.nativeHost !== "shared" && protocol.nativeHost !== "per-extension")
      problems.push(`${protocol.id} has an unknown nativeHost ${String(protocol.nativeHost)}`);
    if (!Number.isInteger(protocol.bridgeProtocolVersion) || protocol.bridgeProtocolVersion < 1)
      problems.push(`${protocol.id} has no bridgeProtocolVersion`);
    if (!versionParts(protocol.minimumAgent))
      problems.push(`${protocol.id} has no minimumAgent release version`);
    if (day(protocol.releasedOn) === null)
      problems.push(`${protocol.id} has no releasedOn date (YYYY-MM-DD)`);
  }
  for (const protocol of compat.protocols) {
    const retiredOn = protocol.retiredOn === undefined ? undefined : day(protocol.retiredOn);
    if (retiredOn === undefined) {
      if (protocol.retiredBy !== undefined || protocol.retiredBeforeThisRule !== undefined)
        problems.push(`${protocol.id} names a replacement but has no retiredOn date`);
      continue;
    }
    if (retiredOn === null) {
      problems.push(`${protocol.id} has a malformed retiredOn date`);
      continue;
    }
    const replacement = protocol.retiredBy ? byId.get(protocol.retiredBy) : undefined;
    if (
      !replacement ||
      replacement.retiredOn !== undefined ||
      replacement.build !== protocol.build
    ) {
      problems.push(
        `${protocol.id} must name in retiredBy the current protocol of the same build that replaced it`,
      );
      continue;
    }
    if (protocol.retiredBeforeThisRule) {
      if (!RETIRED_BEFORE_THIS_RULE.has(protocol.id))
        problems.push(`${protocol.id} cannot be retired before this rule; it postdates it`);
      continue;
    }
    const released = day(replacement.releasedOn);
    if (released !== null && retiredOn < released + RETIREMENT_DAYS * DAY_MS) {
      problems.push(
        `${protocol.id} can be retired from ${new Date(released + RETIREMENT_DAYS * DAY_MS).toISOString().slice(0, 10)}, ${RETIREMENT_DAYS} days after ${replacement.id} was released: until then installed extensions still use it`,
      );
    }
  }
  return problems;
}

/** The protocol an extension of `build` uses, when the record supports it. */
export function currentProtocol(
  compat: BridgeCompat,
  build: ExtensionBuild,
  bridgeProtocolVersion: number,
  nativeHost: NativeHostScheme,
): BridgeProtocol | null {
  return (
    compat.protocols.find(
      (protocol) =>
        protocol.retiredOn === undefined &&
        protocol.build === build &&
        protocol.bridgeProtocolVersion === bridgeProtocolVersion &&
        protocol.nativeHost === nativeHost,
    ) ?? null
  );
}

type ReleaseFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The newest agent release people can install: published, not a draft or
 * prerelease, tagged `agent-v<version>`. */
export async function latestAgentRelease(options: {
  fetch: ReleaseFetch;
  repository: string;
  token?: string;
  apiUrl?: string;
}): Promise<string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let latest: string | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const url = `${options.apiUrl ?? "https://api.github.com"}/repos/${options.repository}/releases?per_page=100&page=${page}`;
    const response = await options.fetch(url, { headers });
    if (!response.ok)
      throw new Error(
        `Listing releases failed with HTTP ${response.status}: ${await response.text()}`,
      );
    const releases = (await response.json()) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    }[];
    for (const release of releases) {
      const version = release.tag_name?.match(/^agent-v(\d+\.\d+\.\d+)$/u)?.[1];
      if (!version || release.draft || release.prerelease) continue;
      if (latest === null || compareVersions(version, latest) > 0) latest = version;
    }
    if (releases.length < 100) break;
  }
  if (latest === null) throw new Error("No released agent was found.");
  return latest;
}

/** Refuses a store release whose protocol no released agent supports yet. */
export function assertReleasedAgentSupports(protocol: BridgeProtocol, latestAgent: string): void {
  if (compareVersions(latestAgent, protocol.minimumAgent) < 0) {
    throw new Error(
      `This extension needs agent ${protocol.minimumAgent} or newer (${protocol.id}), but the newest released agent is ${latestAgent}. Release the agent first; installed agents would refuse this extension.`,
    );
  }
}
