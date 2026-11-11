/** Versioned, read-only inspection from `opengeni-agent service status --json`. */
export interface AgentServiceStatus {
  schemaVersion: 1;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  binaryPath: string | null;
}

export function parseAgentServiceStatus(output: string): AgentServiceStatus | null {
  // Logs may accompany stdout; only accept a complete, versioned JSON object.
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as Partial<AgentServiceStatus>;
      if (
        value.schemaVersion === 1 &&
        typeof value.installed === "boolean" &&
        typeof value.enabled === "boolean" &&
        typeof value.running === "boolean" &&
        (value.binaryPath === null || typeof value.binaryPath === "string")
      )
        return value as AgentServiceStatus;
    } catch {
      // An older agent's help or an inspection failure is not service state.
    }
  }
  return null;
}
