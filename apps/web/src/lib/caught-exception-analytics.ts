// Errors React error boundaries catch never reach `window`, so PostHog's
// exception autocapture cannot see them. The root's `onCaughtError` hands them
// here. Analytics loads lazily and only with consent; until it installs its
// sink, a caught error is not reported to it. This module stays tiny because
// the entry point imports it eagerly.
import type { ExceptionSource } from "./posthog-exception-scrubbing";

type CaughtExceptionSink = (error: unknown, source: ExceptionSource) => void;

let sink: CaughtExceptionSink | null = null;

export function installCaughtExceptionAnalytics(value: CaughtExceptionSink | null): void {
  sink = value;
}

export function reportCaughtExceptionToAnalytics(error: unknown, source: ExceptionSource): void {
  try {
    sink?.(error, source);
  } catch {
    // Optional telemetry cannot fail product work.
  }
}
