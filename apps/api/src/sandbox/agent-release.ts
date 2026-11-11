import { readFileSync } from "node:fs";
import type { Settings } from "@opengeni/config";

// The agent workspace manifest of the source tree this API was built from: the
// copy beside the bundled process (scripts/build-runtime-processes.ts), or the
// repository's own when the API runs from source. A published package carries
// neither, so its stable release must be configured explicitly.
const AGENT_MANIFEST_CANDIDATES = [
  new URL("./assets/agent/Cargo.toml", import.meta.url),
  new URL("../../../../agent/Cargo.toml", import.meta.url),
];

const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

let sourceTreeVersion: { version: string | null } | undefined;

/** The agent workspace version a manifest declares, or null. Every agent
 * release is tagged `agent-v<version>` from this field. */
export function agentWorkspaceVersion(manifest: string): string | null {
  const parsed = Bun.TOML.parse(manifest) as { workspace?: { package?: { version?: unknown } } };
  const version = parsed.workspace?.package?.version;
  return typeof version === "string" && RELEASE_VERSION.test(version) ? version : null;
}

/** The agent release of this API's own source tree, read once; null when the
 * API runs without one. */
export function sourceTreeAgentVersion(): string | null {
  sourceTreeVersion ??= { version: readSourceTreeAgentVersion() };
  return sourceTreeVersion.version;
}

function readSourceTreeAgentVersion(): string | null {
  for (const candidate of AGENT_MANIFEST_CANDIDATES) {
    let manifest: string;
    try {
      manifest = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    const version = agentWorkspaceVersion(manifest);
    if (version) return version;
  }
  return null;
}

/** The stable channel's agent release: the operator's pin when set, otherwise
 * the release of this API's source tree. Following the build keeps installs and
 * updates in step with the control plane; a pin holds or rolls them back. Null
 * when neither names one: nothing is served or pushed rather than an arbitrary
 * older release. */
export function stableAgentVersion(
  settings: Pick<Settings, "agentStableVersion">,
  sourceTree: () => string | null = sourceTreeAgentVersion,
): string | null {
  return settings.agentStableVersion ?? sourceTree();
}

/** Where an immutable agent release keeps one asset: the URL the install and
 * update routes redirect `/agent/v<version>/<asset>` to. */
export function agentReleaseAssetUrl(
  settings: Pick<Settings, "agentReleasesBaseUrl">,
  version: string,
  asset: string,
): string {
  return `${settings.agentReleasesBaseUrl.replace(/\/+$/, "")}/download/agent-v${version}/${asset}`;
}

/** Whether an agent release's signed update manifest can be downloaded:
 * `published`, `missing` (the release host has no such file), or `unknown`
 * (the host could not be asked). */
export type AgentReleaseAvailability = "published" | "missing" | "unknown";
export type AgentReleaseProbe = (version: string) => Promise<AgentReleaseAvailability>;

/** Ask the release host for the manifest an agent fetches to update to
 * `version`, following its redirects, without downloading it. A host that
 * does not answer HEAD (403, 405 or 501) is asked for the manifest's first
 * byte instead. */
export function httpAgentReleaseProbe(
  settings: Pick<Settings, "agentReleasesBaseUrl">,
  fetchImpl?: typeof fetch,
  timeoutMs = 5_000,
): AgentReleaseProbe {
  return async (version) => {
    const url = agentReleaseAssetUrl(settings, version, "manifest.json");
    const ask = (init: RequestInit) =>
      (fetchImpl ?? globalThis.fetch)(url, {
        ...init,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    try {
      const head = await ask({ method: "HEAD" });
      if (head.ok) return "published";
      if (head.status === 404 || head.status === 410) return "missing";
      if (head.status !== 403 && head.status !== 405 && head.status !== 501) return "unknown";
      const get = await ask({ method: "GET", headers: { range: "bytes=0-0" } });
      await get.body?.cancel().catch(() => undefined);
      if (get.ok) return "published";
      return get.status === 403 || get.status === 404 || get.status === 410 ? "missing" : "unknown";
    } catch {
      return "unknown";
    }
  };
}

/** The agent release an update may target on each channel. */
export type PublishedAgentReleases = {
  /** The newest published release at or below the channel's promoted build,
   * or null when none can be confirmed now. */
  resolve(channel: string | null): Promise<string | null>;
  /** The channel's pinned release, or the last release a resolution here
   * confirmed published, without asking the release host: undefined when
   * none has yet. */
  peek(channel: string | null): string | null | undefined;
};

/** How many older patch releases are tried when the source tree's release is
 * not published yet. A release is normally published soon after its version
 * lands, so the gap is a few versions at most. A new minor or major version
 * has no older patch release to fall back to: until it is published, nothing
 * is targeted. */
export const PUBLISHED_AGENT_RELEASE_SEARCH_DEPTH = 16;
const MISSING_RELEASE_RECHECK_MS = 5 * 60_000;
const UNKNOWN_RELEASE_RECHECK_MS = 60_000;
const UNCONFIRMED_WARNING_INTERVAL_MS = 15 * 60_000;

type ReleaseWarning = (message: string, fields: Record<string, string>) => void;

/**
 * Updates target only releases an agent can download. An operator's pin
 * names a release that operator promoted, and is used as it is: requiring
 * the release host to confirm it would make a rollback depend on that host.
 * Without one, the channel follows this API's source tree, whose agent
 * version is raised when a change lands, before the agent release workflow
 * publishes it. That version is used once its manifest exists; until then
 * the newest published patch release below it is, so machines further
 * behind still move forward. Published releases are immutable and
 * remembered; a missing or unanswered check is repeated after a short
 * interval. While the release host cannot be asked, or no release near the
 * source tree's is published, `warn` is told, at most every 15 minutes.
 */
export function createPublishedAgentReleases(
  settings: Pick<Settings, "agentStableVersion" | "agentBetaVersion" | "agentReleasesBaseUrl">,
  options: {
    probe?: AgentReleaseProbe;
    sourceTree?: () => string | null;
    now?: () => number;
    warn?: ReleaseWarning;
  } = {},
): PublishedAgentReleases & { setWarn(warn: ReleaseWarning): void } {
  const probe = options.probe ?? httpAgentReleaseProbe(settings);
  const sourceTree = options.sourceTree ?? sourceTreeAgentVersion;
  const now = options.now ?? Date.now;
  let warn = options.warn;
  let warnedAt = Number.NEGATIVE_INFINITY;
  const known = new Map<string, { availability: AgentReleaseAvailability; checkedAt: number }>();
  const inFlight = new Map<string, Promise<AgentReleaseAvailability>>();
  const resolved = new Map<string, string | null>();

  const report = (message: string, version: string) => {
    if (!warn || now() - warnedAt < UNCONFIRMED_WARNING_INTERVAL_MS) return;
    warnedAt = now();
    warn(message, { version, releasesBaseUrl: settings.agentReleasesBaseUrl });
  };

  const availability = async (version: string): Promise<AgentReleaseAvailability> => {
    const cached = known.get(version);
    if (cached) {
      const age = now() - cached.checkedAt;
      if (
        cached.availability === "published" ||
        (cached.availability === "missing" && age < MISSING_RELEASE_RECHECK_MS) ||
        (cached.availability === "unknown" && age < UNKNOWN_RELEASE_RECHECK_MS)
      ) {
        return cached.availability;
      }
    }
    const pending = inFlight.get(version);
    if (pending) return await pending;
    const check = probe(version)
      .catch((): AgentReleaseAvailability => "unknown")
      .then((result) => {
        known.set(version, { availability: result, checkedAt: now() });
        if (result === "unknown") {
          report(
            "Could not check whether an agent release is published; Connected Machine agent updates wait until the release host answers",
            version,
          );
        }
        return result;
      })
      .finally(() => inFlight.delete(version));
    inFlight.set(version, check);
    return await check;
  };

  const pinned = (channel: string | null): string | undefined =>
    (channel === "beta" ? settings.agentBetaVersion : undefined) ?? settings.agentStableVersion;

  const search = async (): Promise<string | null> => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(sourceTree() ?? "");
    if (!match) return null;
    const [major, minor, patch] = [match[1]!, match[2]!, Number(match[3])];
    const lowest = Math.max(0, patch - PUBLISHED_AGENT_RELEASE_SEARCH_DEPTH);
    for (let candidate = patch; candidate >= lowest; candidate -= 1) {
      const version = `${major}.${minor}.${candidate}`;
      const result = await availability(version);
      if (result === "published") return version;
      // An unanswered check cannot tell whether this newer release is
      // published; target nothing until it can.
      if (result === "unknown") return null;
    }
    // A host that denies every request looks like this too.
    report(
      "No published agent release found near this deployment's agent version; Connected Machine agent updates wait until one is published",
      `${major}.${minor}.${patch}`,
    );
    return null;
  };

  return {
    async resolve(channel) {
      const target = pinned(channel) ?? (await search());
      // An unconfirmed check keeps showing the last published target.
      if (target !== null) resolved.set(channel === "beta" ? "beta" : "stable", target);
      return target;
    },
    peek(channel) {
      return pinned(channel) ?? resolved.get(channel === "beta" ? "beta" : "stable");
    },
    setWarn(next) {
      warn = next;
    },
  };
}

const sharedPublishedAgentReleases = new WeakMap<
  object,
  ReturnType<typeof createPublishedAgentReleases>
>();

/** One resolver per settings object, so every caller reuses its checks.
 * `warn`, when given, receives the resolver's warnings from then on. */
export function publishedAgentReleasesFor(
  settings: Pick<Settings, "agentStableVersion" | "agentBetaVersion" | "agentReleasesBaseUrl">,
  options: { warn?: ReleaseWarning } = {},
): PublishedAgentReleases {
  let releases = sharedPublishedAgentReleases.get(settings);
  if (!releases) {
    releases = createPublishedAgentReleases(settings);
    sharedPublishedAgentReleases.set(settings, releases);
  }
  if (options.warn) releases.setWarn(options.warn);
  return releases;
}
