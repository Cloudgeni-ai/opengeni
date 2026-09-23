/** Durable control records; only providerData is sent by the SDK unknown-item adapter. */
export const REASONING_CONFIGURATION_FIELD = "opengeniReasoningConfiguration";
export type ConfigurationEffort = "low" | "medium" | "high" | "xhigh" | "max";
const efforts = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
export function supportsReasoningConfiguration(
  model: string,
  effort: string,
): effort is ConfigurationEffort {
  return model === "gpt-6-astra" && efforts.has(effort);
}
export type ReasoningConfiguration = {
  version: 1;
  baselineEffort: ConfigurationEffort;
  effort: ConfigurationEffort;
  turnId: string;
};
export function readReasoningConfiguration(
  item: Record<string, unknown>,
): ReasoningConfiguration | null {
  const state = item[REASONING_CONFIGURATION_FIELD] as ReasoningConfiguration | undefined;
  if (
    !state ||
    state.version !== 1 ||
    !efforts.has(state.baselineEffort) ||
    !efforts.has(state.effort) ||
    typeof state.turnId !== "string"
  )
    return null;
  const data = item.providerData as Record<string, unknown> | undefined;
  if (
    item.type !== "unknown" ||
    data?.type !== "configuration_update" ||
    (data.reasoning as { effort?: unknown })?.effort !== state.effort
  )
    return null;
  return state;
}
export function reasoningConfigurationItem(state: ReasoningConfiguration): Record<string, unknown> {
  return {
    type: "unknown",
    providerData: { type: "configuration_update", reasoning: { effort: state.effort } },
    [REASONING_CONFIGURATION_FIELD]: state,
  };
}
export function latestReasoningConfiguration(
  items: readonly Record<string, unknown>[],
): ReasoningConfiguration | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const state = readReasoningConfiguration(items[i]!);
    if (state) return state;
  }
  return null;
}
export function isReasoningConfigurationUpdate(item: Record<string, unknown>): boolean {
  return (
    item.type === "configuration_update" ||
    (item.type === "unknown" &&
      (item.providerData as { type?: unknown } | undefined)?.type === "configuration_update")
  );
}
/** Never leak Astra controls to an incompatible model. Coalesce only adjacent controls. */
export function projectReasoningConfigurations(
  items: Record<string, unknown>[],
  enabled: boolean,
): Record<string, unknown>[] {
  const projected: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isReasoningConfigurationUpdate(item)) {
      projected.push(item);
      continue;
    }
    if (!enabled) continue;
    if (projected.length && isReasoningConfigurationUpdate(projected[projected.length - 1]!))
      projected.pop();
    projected.push(
      item.type === "unknown"
        ? { type: "unknown", providerData: item.providerData }
        : {
            type: "unknown",
            providerData: { type: "configuration_update", reasoning: item.reasoning },
          },
    );
  }
  return projected;
}
