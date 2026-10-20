/**
 * What the popup tells a person when this profile is not connected. Chrome
 * reports native messaging failures as fixed English strings; each points to
 * a different thing the person can do on this computer.
 */
export type AgentConnectionProblem = {
  /** Chrome's message, or the extension's own reason. */
  error: string;
  /** The agent accepted this profile at least once since the browser started. */
  everConnected: boolean;
};

export const AGENT_NOT_SET_UP =
  "Opengeni isn't set up for this browser on this computer. Connect this computer in the Opengeni app, or install the Opengeni agent, then restart the browser.";

export const AGENT_TOO_OLD =
  "The Opengeni agent on this computer is too old for this extension. Update the Opengeni app or agent on this computer.";

export const AGENT_NOT_ACCEPTING =
  "The Opengeni agent on this computer isn't running or is too old for this extension. Open the Opengeni app or start the agent, and update it if this continues.";

export const AGENT_STOPPED =
  "The Opengeni agent on this computer stopped. This profile reconnects when it runs again.";

export const AGENT_START = "Start the Opengeni machine agent to connect this profile.";

export function agentUnavailableDetail(problem: AgentConnectionProblem | null): string {
  if (!problem) return AGENT_START;
  const error = problem.error.toLowerCase();
  if (error.includes("native messaging host not found")) return AGENT_NOT_SET_UP;
  // Older agents allowed only the development extension, not the store one.
  if (error.includes("native messaging host is forbidden")) return AGENT_TOO_OLD;
  if (problem.everConnected) return AGENT_STOPPED;
  // The host started but the agent never accepted the hello: no agent is
  // running, or an older agent refused this extension's message.
  return AGENT_NOT_ACCEPTING;
}
