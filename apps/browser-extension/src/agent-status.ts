import type { AgentUnavailable } from "./protocol";

/**
 * What the popup tells a person when this profile is not connected. Current
 * agents say why they refuse a connection; for older agents and Chrome's own
 * native messaging failures (fixed English strings) the extension infers it.
 * Each status names the side to start or update.
 */
export type AgentConnectionProblem = {
  /** Chrome's message, or the extension's own reason. */
  error: string;
  /** The agent accepted this profile at least once since the browser started. */
  everConnected: boolean;
  /** The agent side's own explanation for the last refused connection. */
  refusal?: AgentUnavailable | null;
};

export type AgentStatus = {
  /** Short popup headline. */
  title: string;
  /** What happened and what to do about it. */
  detail: string;
};

/** The extension's reason when a host starts but the agent never answers. */
export const HANDSHAKE_TIMEOUT_ERROR = "Opengeni agent did not answer this browser profile";

export const AGENT_NOT_SET_UP: AgentStatus = {
  title: "Not set up on this computer",
  detail:
    "Opengeni isn't set up for this browser on this computer. Connect this computer in the Opengeni app, or install the Opengeni agent, then restart the browser.",
};

export const AGENT_NOT_RUNNING: AgentStatus = {
  title: "Agent not running",
  detail:
    "The Opengeni agent isn't running on this computer. Open the Opengeni app or start the agent; this profile connects as soon as it runs.",
};

export const AGENT_NOT_RESPONDING: AgentStatus = {
  title: "Agent not responding",
  detail:
    "The Opengeni agent on this computer did not answer. Restart the Opengeni app or the agent.",
};

export const AGENT_STOPPED: AgentStatus = {
  title: "Agent stopped",
  detail:
    "The Opengeni agent on this computer stopped. This profile reconnects when it runs again.",
};

export const CONNECTING: AgentStatus = {
  title: "Connecting",
  detail: "Connecting to the Opengeni agent on this computer.",
};

export function agentOutdated(agentVersion: string | null): AgentStatus {
  const agent = agentVersion ? `Opengeni agent ${agentVersion}` : "Opengeni agent";
  return {
    title: "Update the Opengeni agent",
    detail: `The ${agent} on this computer is older than this extension. Update the Opengeni app or agent on this computer, or restart it if it just updated; then this profile connects.`,
  };
}

export function extensionOutdated(agentVersion: string | null): AgentStatus {
  const agent = agentVersion ? `Opengeni agent ${agentVersion}` : "Opengeni agent";
  return {
    title: "Update this extension",
    detail: `This Opengeni extension is older than the ${agent} on this computer. Chrome is updating it now; if this stays, update it from chrome://extensions.`,
  };
}

export function agentRefused(detail: string | null): AgentStatus {
  return {
    title: "Agent refused this browser",
    detail: `The Opengeni agent on this computer did not accept this browser${detail ? ` (${detail})` : ""}. Restart the Opengeni app or the agent, and update it if this continues.`,
  };
}

export function agentStatus(problem: AgentConnectionProblem | null): AgentStatus {
  if (!problem) return CONNECTING;
  const refusal = problem.refusal;
  if (refusal) {
    switch (refusal.reason) {
      case "agent_not_running":
        return AGENT_NOT_RUNNING;
      case "agent_outdated":
        return agentOutdated(refusal.agentVersion);
      case "extension_outdated":
        return extensionOutdated(refusal.agentVersion);
      case "agent_error":
        return agentRefused(refusal.detail);
    }
  }
  const error = problem.error.toLowerCase();
  if (error.includes("native messaging host not found")) return AGENT_NOT_SET_UP;
  // The registration names a program Chrome cannot start (removed or moved).
  if (error.includes("failed to start native messaging host")) return AGENT_NOT_SET_UP;
  // Older agents allowed only the development extension, not the store one.
  if (error.includes("native messaging host is forbidden")) return agentOutdated(null);
  if (problem.error === HANDSHAKE_TIMEOUT_ERROR) return AGENT_NOT_RESPONDING;
  if (problem.everConnected) return AGENT_STOPPED;
  // Current agents explain every refusal before closing. A host that closed
  // without a word before this profile was ever accepted is an older agent.
  return agentOutdated(null);
}
