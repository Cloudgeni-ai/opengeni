import { SESSION_TURN_SURFACES, type SessionTurnSurface } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";

/**
 * Live, content-free product usage counters recorded where work is accepted.
 * Every label is a closed set: the product surface (or `unknown` when no
 * surface was captured), who created a session (`subject` or `service`), and
 * whether the session is a root. No workspace, user, model or text value ever
 * becomes a label.
 */
export type ProductUsageMetricsSink = Pick<Observability, "incrementCounter">;

export const PRODUCT_USAGE_SURFACE_LABELS = [...SESSION_TURN_SURFACES, "unknown"] as const;
export type ProductUsageSurfaceLabel = (typeof PRODUCT_USAGE_SURFACE_LABELS)[number];
export const SESSION_CREATED_BY_KINDS = ["subject", "service"] as const;
export type SessionCreatedByKind = (typeof SESSION_CREATED_BY_KINDS)[number];

const SESSIONS_CREATED_METRIC = {
  name: "opengeni_sessions_created_total",
  help: "Sessions created by product surface, creator kind, and whether they are root sessions.",
} as const;
const USER_MESSAGES_METRIC = {
  name: "opengeni_user_messages_total",
  help: "Accepted user messages and scheduled prompts by product surface.",
} as const;

export function productUsageSurfaceLabel(
  surface: SessionTurnSurface | null | undefined,
): ProductUsageSurfaceLabel {
  return surface && (SESSION_TURN_SURFACES as readonly string[]).includes(surface)
    ? surface
    : "unknown";
}

function sessionCreatedByKind(kind: string | null | undefined): SessionCreatedByKind {
  return kind === "subject" ? "subject" : "service";
}

/** Count one newly created session. Never throws; replays must not call it. */
export function recordSessionCreated(
  sink: ProductUsageMetricsSink | null | undefined,
  input: {
    surface: SessionTurnSurface | null | undefined;
    createdByKind: string | null | undefined;
    parentSessionId: string | null | undefined;
  },
): void {
  try {
    sink?.incrementCounter({
      ...SESSIONS_CREATED_METRIC,
      labels: {
        surface: productUsageSurfaceLabel(input.surface),
        created_by_kind: sessionCreatedByKind(input.createdByKind),
        root: input.parentSessionId ? "false" : "true",
      },
    });
  } catch {
    // Telemetry must never change the create outcome.
  }
}

/** Count one newly accepted user message. Never throws; replays must not call it. */
export function recordUserMessageAccepted(
  sink: ProductUsageMetricsSink | null | undefined,
  input: { surface: SessionTurnSurface | null | undefined },
): void {
  try {
    sink?.incrementCounter({
      ...USER_MESSAGES_METRIC,
      labels: { surface: productUsageSurfaceLabel(input.surface) },
    });
  } catch {
    // Telemetry must never change the send outcome.
  }
}

/**
 * Publish every closed series at zero so dashboards can tell a quiet surface
 * from missing instrumentation. Never throws.
 */
export function registerProductUsageMetricBaselines(
  sink: ProductUsageMetricsSink | null | undefined,
): void {
  if (!sink) return;
  try {
    for (const surface of PRODUCT_USAGE_SURFACE_LABELS) {
      sink.incrementCounter({ ...USER_MESSAGES_METRIC, labels: { surface }, amount: 0 });
      for (const createdByKind of SESSION_CREATED_BY_KINDS) {
        for (const root of ["true", "false"]) {
          sink.incrementCounter({
            ...SESSIONS_CREATED_METRIC,
            labels: { surface, created_by_kind: createdByKind, root },
            amount: 0,
          });
        }
      }
    }
  } catch {
    // Telemetry only; series appear on their first real increment.
  }
}
