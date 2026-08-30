export type OpenGeniSessionStatus =
  | "queued"
  | "starting"
  | "running"
  | "idle"
  | "requires_action"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | (string & {});

export type SessionStatusPresentation = Readonly<{
  label: string;
  tone: "neutral" | "accent" | "waiting" | "danger";
  live: boolean;
}>;

export function sessionStatusPresentation(
  status: OpenGeniSessionStatus,
): SessionStatusPresentation {
  switch (status) {
    case "starting":
    case "running":
      return Object.freeze({
        label: status === "starting" ? "Starting" : "Running",
        tone: "accent",
        live: true,
      });
    case "requires_action":
      return Object.freeze({ label: "Needs input", tone: "waiting", live: true });
    case "paused":
      return Object.freeze({ label: "Paused", tone: "waiting", live: false });
    case "failed":
      return Object.freeze({ label: "Failed", tone: "danger", live: false });
    case "cancelled":
      return Object.freeze({ label: "Cancelled", tone: "neutral", live: false });
    case "completed":
      return Object.freeze({ label: "Completed", tone: "neutral", live: false });
    case "idle":
      return Object.freeze({ label: "Idle", tone: "neutral", live: false });
    case "queued":
      return Object.freeze({ label: "Queued", tone: "neutral", live: true });
    default:
      return Object.freeze({ label: humanizeStatus(status), tone: "neutral", live: false });
  }
}

function humanizeStatus(status: string): string {
  const normalized = status.replace(/[_-]+/gu, " ").trim();
  return normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}` : "Unknown";
}
