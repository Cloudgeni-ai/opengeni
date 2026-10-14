/**
 * Person-facing copy for finite same-turn provider recovery. Presentation only:
 * retry authority, pacing and the recovery budget stay in `errors.ts`.
 *
 * `@opengeni/react` (`lib/provider-recovery.ts`) composes the same sentences
 * from the structured event fields, so live retry status and historical
 * failures read identically in every surface. Keep the two in step.
 */

/** Closed provider condition recorded on model-provider recovery payloads. */
export type ProviderCondition = "overloaded" | "unavailable" | "unresponsive" | "rate_limited";

/** Failure codes whose transient condition belongs to the turn's model route. */
export const MODEL_PROVIDER_RECOVERY_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "provider_rate_limited",
  "provider_unknown_finish_reason",
  "post_compaction_continuation_empty",
]);

export type ProviderRecoveryCopyInput = {
  code?: string | null | undefined;
  providerCondition?: ProviderCondition | null | undefined;
  modelLabel?: string | null | undefined;
  providerLabel?: string | null | undefined;
};

function label(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return trimmed ? trimmed.slice(0, 120) : null;
}

/** One present-tense clause naming what is unavailable, without a trailing period. */
export function providerRecoverySubject(input: ProviderRecoveryCopyInput): string {
  const model = label(input.modelLabel) ?? "The model";
  const provider = label(input.providerLabel);
  const at = provider ? ` at the provider (${provider})` : " at the provider";
  switch (input.code) {
    case "provider_rate_limited":
      return `${model} is rate limited${at}`;
    case "provider_unavailable":
      return input.providerCondition === "overloaded"
        ? `${model} is overloaded${at}`
        : input.providerCondition === "unresponsive"
          ? `${model} stopped responding${at}`
          : `${model} is temporarily unavailable${at}`;
    case "provider_unknown_finish_reason":
      return `${model} ended its response unexpectedly`;
    case "post_compaction_continuation_empty":
      return `${model} stopped right after compacting the conversation`;
    case "upstream_connectivity_unavailable":
      return "Opengeni can't reach an upstream service";
    case "mcp_transport_timeout":
      return "A required MCP server isn't responding";
    case "mcp_transport_unavailable":
      return "A required MCP server is unreachable";
    case "sandbox_command_start_unavailable":
      return "The sandbox isn't ready yet";
    case "turn_execution_policy_definition_mismatch":
      return "Opengeni is applying a configuration update";
    default:
      return "A service this turn depends on is temporarily unavailable";
  }
}

/** Terminal copy once the finite automatic recovery budget is spent. */
export function providerRecoveryExhaustedMessage(
  input: ProviderRecoveryCopyInput & { providerRecoveryCount: number },
): string {
  const count = input.providerRecoveryCount;
  const retried = `Opengeni retried ${count} ${count === 1 ? "time" : "times"} without success.`;
  const remedy = MODEL_PROVIDER_RECOVERY_CODES.has(input.code ?? "")
    ? "Try again in a few minutes, or switch to another model."
    : "Try again in a few minutes.";
  return `${providerRecoverySubject(input)}. ${retried} ${remedy}`;
}
