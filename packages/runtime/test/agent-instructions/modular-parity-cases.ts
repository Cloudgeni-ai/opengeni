import {
  allAgentCapabilities,
  noneAgentCapabilities,
  type AgentCapabilityId,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import type { BuildAgentOptions } from "../../src/index";

/**
 * Configured compositions in which every feature a conditional section reads
 * is present: web search, goals, something to learn into, something that can
 * resume a wait, a readable Skill index, privacy facts, the search router,
 * documents and Sites, and a shared workspace, rendered with tool search on (`PARITY_SETTINGS`). Their
 * composed bytes were recorded before the
 * pay-for-what-is-relevant gates existed, so a gate can only ever omit text
 * for an absent feature; it never changes a session that has the feature.
 */
function capabilities(
  from: "all" | "none",
  overrides: Partial<Record<AgentCapabilityId, boolean | "read" | "manage">> = {},
): ResolvedAgentCapabilities {
  return {
    ...(from === "all" ? allAgentCapabilities() : noneAgentCapabilities()),
    // Present in every case: each one opens a gate.
    privacyFacts: true,
    ...overrides,
  } as ResolvedAgentCapabilities;
}

function configured(
  caps: ResolvedAgentCapabilities,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: caps,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
    ...overrides,
  };
}

/** Removing any of these from "all" closes no conditional section. */
const GATE_NEUTRAL_REMOVALS: readonly AgentCapabilityId[] = [
  "humanInput",
  "notifications",
  "media",
  "subagents",
  "schedules",
  "browser",
  "secrets",
  "knowledge",
  "workspaceFiles",
  "workspaceConnectors",
  "workspaceAdmin",
];

const BACKENDS = ["none", "docker", "selfhosted"] as const;

function cases(): Record<string, BuildAgentOptions> {
  const out: Record<string, BuildAgentOptions> = {};
  const add = (name: string, caps: ResolvedAgentCapabilities, extra: BuildAgentOptions = {}) => {
    for (const backend of BACKENDS) {
      out[`${name}/${backend}`] = {
        agentConfig: configured(caps),
        activeSandboxBackend: backend,
        lazyToolTransport: "generic_dispatch",
        ...extra,
      };
    }
  };
  add("all", capabilities("all"));
  add("all/markdown", capabilities("all"), {
    agentConfig: configured(capabilities("all"), { renderer: "markdown" }),
  });
  add("all/unattended", capabilities("all"), { unattended: true });
  add("all/secret-references", capabilities("all"), {
    secrets: { referencesEnabled: true, hasActingHuman: true },
  });
  add("all/skills-read", capabilities("all", { skills: "read" }));
  add("all/identity", capabilities("all"), {
    agentConfig: configured(capabilities("all"), { identity: "You are the Acme assistant." }),
  });
  for (const id of GATE_NEUTRAL_REMOVALS)
    add(`all-without-${id}`, capabilities("all", { [id]: false }));
  // The smallest configurations that still have every gated feature.
  const minimal = {
    webSearch: true,
    goals: true,
    knowledge: true,
    artifacts: true,
  };
  out["none-with-features/docker"] = {
    agentConfig: configured(capabilities("none", minimal)),
    activeSandboxBackend: "docker",
    lazyToolTransport: "generic_dispatch",
  };
  out["none-with-features/selfhosted"] = {
    agentConfig: configured(capabilities("none", minimal)),
    activeSandboxBackend: "selfhosted",
    lazyToolTransport: "generic_dispatch",
  };
  out["none-with-features-and-workspace/none"] = {
    agentConfig: configured(capabilities("none", { ...minimal, workspaceFiles: true })),
    activeSandboxBackend: "none",
    lazyToolTransport: "generic_dispatch",
  };
  out["none-with-features-manage/none"] = {
    agentConfig: configured(
      capabilities("none", {
        webSearch: true,
        goals: true,
        skills: "manage",
        workspaceAdmin: true,
        artifacts: true,
      }),
    ),
    activeSandboxBackend: "none",
    lazyToolTransport: "generic_dispatch",
  };
  return out;
}

export const MODULAR_PARITY_CASES: Record<string, BuildAgentOptions> = cases();

/** Tool search is on, so the router exists whenever the case installs a transport. */
export const PARITY_SETTINGS = { lazyToolSearchEnabled: true } as const;
