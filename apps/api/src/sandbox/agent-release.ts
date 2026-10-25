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
