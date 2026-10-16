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

/**
 * Where the app keeps the agent it runs: the same place the command-line
 * installer uses, so there is one agent per person, `opengeni-agent` keeps
 * working in a terminal, and the agent's own signed updates replace it there.
 */
export function hostedAgentPath(
  platform: AgentPlatform,
  home: string,
  env: Record<string, string | undefined>,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "Opengeni", "bin", "opengeni-agent.exe");
  }
  // The target platform's separators, whatever platform computes the paths.
  return posix.join(home, ".local", "bin", "opengeni-agent");
}

/**
 * The standalone macOS agent app the command-line installer used to create.
 * Its background service and its own entries in Privacy & Security are what the
 * app replaces.
 */
export function standaloneMacAgentApp(home: string): string {
  return posix.join(home, "Applications", "OpenGeni Agent.app");
}

/** `opengeni-agent --version` prints `opengeni-agent 0.1.65`. */
export function parseAgentVersion(output: string): string | null {
  return /\bopengeni-agent\s+v?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

export type AgentPermissionId = "screenRecording" | "accessibility" | "inputMonitoring";

/**
 * `opengeni-agent permissions` prints one JSON line. Screen control on a Mac
 * needs Screen Recording (to see), Accessibility (to click and type) and Input
 * Monitoring (so the agent's input gives way to the person's own); other
 * systems need nothing. Null when the agent is too old to answer.
 */
export function parsePermissions(
  output: string,
): { required: false } | { required: true; granted: Record<AgentPermissionId, boolean> } | null {
  for (const line of output.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (value.required === false) return { required: false };
      if (
        value.required === true &&
        typeof value.screenRecording === "boolean" &&
        typeof value.accessibility === "boolean" &&
        typeof value.inputMonitoring === "boolean"
      ) {
        return {
          required: true,
          granted: {
            screenRecording: value.screenRecording,
            accessibility: value.accessibility,
            inputMonitoring: value.inputMonitoring,
          },
        };
      }
    } catch {
      // Not the line we want.
    }
  }
  return null;
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

/**
 * The reason a command failed, for a plain error message: the line the
 * installer or agent marked as an error, else the last thing it printed, without
 * its tool prefix.
 */
export function lastErrorLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").trim())
    .filter(Boolean);
  const line =
    [...lines].reverse().find((candidate) => /\berror:/iu.test(candidate)) ?? lines.at(-1);
  return line
    ? line
        .replace(/^(?:opengeni-install|opengeni-agent install):\s*/iu, "")
        .replace(/^error:\s*/iu, "")
        .slice(0, 300)
    : null;
}
