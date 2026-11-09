import type { ModelBillingAttributionV1 } from "@opengeni/contracts";
import { failureOrigin, type FailureOrigin } from "@opengeni/observability";

/** The turn control fields that carry attribution from settlement to the terminal metric. */
export interface TurnFailureOriginControl {
  turnFailureOrigin?: FailureOrigin;
}

/**
 * Attribute the settled turn and keep the origin on the turn control, where
 * finalization reads it for `opengeni_turns_total`.
 */
export function recordSettledTurnFailureOrigin(
  control: TurnFailureOriginControl,
  billing: ModelBillingAttributionV1,
  turnStatus: string,
  events: readonly { type: string; payload?: unknown }[],
): FailureOrigin {
  const origin = settledTurnFailureOrigin(billing, turnStatus, events);
  control.turnFailureOrigin = origin;
  return origin;
}

/** The attribution finalization passes to the terminal turn metric. */
export function turnFailureOriginMetricFields(control: TurnFailureOriginControl): {
  failureOrigin?: FailureOrigin;
} {
  return control.turnFailureOrigin ? { failureOrigin: control.turnFailureOrigin } : {};
}

/** Called only after the exact attempt wins durable settlement. */
export function settledTurnFailureOrigin(
  billing: ModelBillingAttributionV1,
  turnStatus: string,
  events: readonly { type: string; payload?: unknown }[],
): FailureOrigin {
  const value = events.find((event) => event.type === "turn.failed")?.payload;
  const payload =
    value !== null && typeof value === "object"
      ? (value as {
          code?: unknown;
          waitReason?: unknown;
          refusal?: unknown;
          providerAccountRefusal?: unknown;
          quotaScope?: unknown;
        })
      : undefined;
  return failureOrigin({
    // External metering also covers deployment-owned free/anonymous routes.
    // The accepted payer, not the price or metering mode, establishes ownership.
    customerManaged: billing.upstreamPayer !== "deployment",
    outcome: turnStatus === "failed" ? "failed" : "completed",
    code: payload?.code,
    waitReason: payload?.waitReason,
    refusal: payload?.refusal,
    providerAccountRefusal: payload?.providerAccountRefusal,
    quotaScope: payload?.quotaScope,
  });
}
