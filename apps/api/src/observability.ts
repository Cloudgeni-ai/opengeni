import type { EventLogger } from "@opengeni/events";
import type { Attributes, AttributeValue, Observability } from "@opengeni/observability";

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
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    sanitized[key] = eventAttributeValue(value);
  }
  return sanitized;
}

function eventAttributeValue(value: unknown): AttributeValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
