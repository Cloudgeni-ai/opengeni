// Consent-gated onboarding journey (PostHog through `captureAnalyticsEvent`)
// for the post-sign-in setup in organization-onboarding-panel.tsx and
// model-access-onboarding.tsx:
//
//   onboarding_step_viewed{step, variant?}
//   onboarding_step_completed{step, via}
//   onboarding_abandoned{last_step}
//
// Steps and values are closed. `onboarding_abandoned` is best effort: the
// onboarding view unmounted or the page was left while a step was shown and
// before the final step completed (for example signing out, switching
// account, or closing the tab).
import { useEffect } from "react";

import { captureAnalyticsEvent } from "./analytics-observer";

export const ONBOARDING_STEPS = ["organization_name", "invitation", "model_access"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** How a step was completed. */
export const ONBOARDING_COMPLETIONS = {
  organization_name: ["created"],
  invitation: ["joined"],
  model_access: ["start_chatting", "skipped", "connected_model", "checkout"],
} as const satisfies Record<OnboardingStep, readonly string[]>;
export type OnboardingCompletion<Step extends OnboardingStep> =
  (typeof ONBOARDING_COMPLETIONS)[Step][number];

/** The model-access screen variant, by what the organization already has. */
export type ModelAccessVariant = "credits" | "included" | "choose";

const FINAL_STEPS: ReadonlySet<OnboardingStep> = new Set(["invitation", "model_access"]);

type Capture = (
  name: "onboarding_step_viewed" | "onboarding_step_completed" | "onboarding_abandoned",
  properties: Record<string, string>,
) => void;

export type OnboardingJourney = {
  viewed(step: OnboardingStep, variant?: ModelAccessVariant): void;
  completed<Step extends OnboardingStep>(step: Step, via: OnboardingCompletion<Step>): void;
  /** The onboarding view went away or the page is being left. */
  left(): void;
};

export function createOnboardingJourney(
  capture: Capture = (name, properties) => void captureAnalyticsEvent(name, properties),
): OnboardingJourney {
  const viewed = new Set<OnboardingStep>();
  const completed = new Set<OnboardingStep>();
  let lastStep: OnboardingStep | null = null;
  let finished = false;
  const send: Capture = (name, properties) => {
    try {
      capture(name, properties);
    } catch {
      // Optional telemetry cannot fail product work.
    }
  };
  return {
    viewed(step, variant) {
      if (finished) return;
      lastStep = step;
      if (viewed.has(step)) return;
      viewed.add(step);
      send("onboarding_step_viewed", { step, ...(variant ? { variant } : {}) });
    },
    completed(step, via) {
      if (finished || completed.has(step)) return;
      completed.add(step);
      if (FINAL_STEPS.has(step)) finished = true;
      send("onboarding_step_completed", { step, via });
    },
    left() {
      if (finished || lastStep === null) return;
      finished = true;
      send("onboarding_abandoned", { last_step: lastStep });
    },
  };
}

let journey: OnboardingJourney | null = null;
let pageHideInstalled = false;

/** The page-wide onboarding journey. */
export function onboardingJourney(): OnboardingJourney {
  journey ??= createOnboardingJourney();
  if (!pageHideInstalled && typeof window !== "undefined") {
    pageHideInstalled = true;
    window.addEventListener("pagehide", () => journey?.left());
  }
  return journey;
}

/**
 * Report the onboarding view's current step while mounted. Leaving the view
 * without finishing counts as abandoned; the check waits one task so an
 * immediate remount (React StrictMode) is not mistaken for leaving.
 */
export function useOnboardingStep(
  step: OnboardingStep | null,
  variant?: ModelAccessVariant,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled || !step) return;
    onboardingJourney().viewed(step, variant);
  }, [enabled, step, variant]);
  useEffect(() => {
    if (!enabled) return;
    mounted += 1;
    return () => {
      mounted -= 1;
      setTimeout(() => {
        if (mounted === 0) journey?.left();
      }, 0);
    };
  }, [enabled]);
}
let mounted = 0;
