// Reading the connected-machine agent's command line output. Pure, so the
// formats are pinned by tests.

import { posix, win32 } from "node:path";

import { normalizeServerUrl } from "@opengeni/sdk/app-links";

export type AgentPlatform = "darwin" | "linux" | "win32";

export interface AgentConnection {
  connectionId: string;
  /** The server origin, normalized. */
  apiUrl: string;
  workspaceId: string;
  agentId: string;
}

/** Where the deployment's installer puts the agent, most specific first. */
export function agentBinaryCandidates(
  platform: AgentPlatform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    return [win32.join(localAppData, "Opengeni", "bin", "opengeni-agent.exe")];
  }
  // The target platform's separators, whatever platform computes the paths.
  const join = posix.join;
  const candidates: string[] = [];
  if (platform === "darwin") {
    candidates.push(
      join(home, "Applications", "OpenGeni Agent.app", "Contents", "MacOS", "opengeni-agent"),
    );
  }
  candidates.push(join(home, ".local", "bin", "opengeni-agent"));
  return candidates;
}

/**
 * `opengeni-agent connections` lists one connection per line:
 * `  <id>  <api url>[ (note)]  workspace=<uuid>  agent=<uuid>`.
 */
export function parseConnections(stdout: string): AgentConnection[] {
  const connections: AgentConnection[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+(https?:\/\/\S+).*?\sworkspace=(\S+)\s+agent=(\S+)\s*$/u.exec(line);
    if (!match) continue;
    const apiUrl = normalizeServerUrl(match[2]!);
    if (!apiUrl) continue;
    connections.push({
      connectionId: match[1]!,
      apiUrl,
      workspaceId: match[3]!,
      agentId: match[4]!,
    });
  }
  return connections;
}

/**
 * Whether `opengeni-agent status` reports the background agent running:
 * systemd prints `active`, launchd `loaded`, Windows `sc query` `RUNNING`.
 */
export function parseServiceRunning(stdout: string): boolean {
  if (/LaunchAgent:\s*loaded\b/iu.test(stdout)) return true;
  if (/service:\s*active\b/iu.test(stdout)) return true;
  return /STATE\s*:\s*\d+\s+RUNNING/iu.test(stdout);
}

/** The connection that serves this server's workspace, if any. */
export function connectionFor(
  connections: readonly AgentConnection[],
  baseUrl: string,
  workspaceId: string,
): AgentConnection | null {
  const origin = normalizeServerUrl(baseUrl);
  return (
    connections.find(
      (connection) => connection.apiUrl === origin && connection.workspaceId === workspaceId,
    ) ?? null
  );
}

/** The last meaningful line of a failed command, for a plain error message. */
export function lastErrorLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").trim())
    .filter(Boolean);
  const line = lines.at(-1);
  return line ? line.replace(/^(?:error|opengeni-agent install):\s*/iu, "").slice(0, 300) : null;
}
