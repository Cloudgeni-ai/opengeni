import type { AgentRunStatus } from "../lib/types";

export function StatusPill({ status }: { status: AgentRunStatus }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}
