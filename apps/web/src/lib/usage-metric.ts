/** Presentation only: metric identity and accounting units stay unchanged. */
export function usageMetricLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "model.cost": "Model spend",
    "model.tokens": "Model tokens",
    "agent_run.created": "Agent runs started",
    "agent_run.completed": "Agent runs completed",
    "sandbox.warm_seconds": "Warm sandbox time",
    "sandbox.warm_cost": "Warm sandbox spend",
    "file.uploaded": "Files uploaded",
    "file.deleted": "Files deleted",
    "document.indexed": "Documents indexed",
    "scheduled_task.fired": "Scheduled tasks started",
    "api_key.request": "API requests",
  };
  return Object.hasOwn(labels, eventType) ? labels[eventType]! : eventType;
}

export function usageUnitLabel(unit: string): string {
  return unit === "usd_micros" ? "USD" : unit;
}
