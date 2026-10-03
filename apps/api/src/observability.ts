import {
  natsSubscriptionTerminationCounter,
  type EventBusOptions,
  type EventLogger,
} from "@opengeni/events";
import type { Attributes, AttributeValue, Observability } from "@opengeni/observability";

/** Logger plus the closed-label subscription-termination counter for NATS connections. */
export function observabilityEventBusOptions(
  observability: Observability,
): Pick<EventBusOptions, "logger" | "onSubscriptionTerminated"> {
  return {
    logger: observabilityEventLogger(observability),
    onSubscriptionTerminated: natsSubscriptionTerminationCounter(observability),
  };
}

export function observabilityEventLogger(observability: Observability): EventLogger {
  return {
    debug: (message, attributes) => observability.debug(message, eventAttributes(attributes)),
    warn: (message, attributes) => observability.warn(message, eventAttributes(attributes)),
  };
}

function eventAttributes(attributes: Record<string, unknown> | undefined): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }
  const projected: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    projected[key] = eventAttributeValue(value);
  }
  return projected;
}

function eventAttributeValue(value: unknown): AttributeValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
