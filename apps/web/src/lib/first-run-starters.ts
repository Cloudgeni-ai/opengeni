import { useAppContext } from "@/context";

import { buildsProduct, composeOpengeniPrompt } from "./first-agent";
import { onboardingJourneyStorageKey, useOnboardingJourney } from "./onboarding-journey";

/**
 * Which starters the new-chat page offers, from the first-run answer this
 * browser saved for this person and organization: a product (built or still
 * explored) gets the product set, with its answers as the "Add an agent to my
 * product" prompt; everyone else, and anyone without a saved answer, the
 * general set.
 */
export function useFirstRunStarters(workspaceId: string): {
  set: "general" | "product";
  productPrompt: string | null;
} {
  const context = useAppContext();
  const organizationId =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId ??
    context.accessContext.defaultAccountId ??
    null;
  const journey = useOnboardingJourney(
    organizationId
      ? onboardingJourneyStorageKey(context.accessContext.subjectId, organizationId)
      : null,
  );
  const answers = journey?.firstAgent ?? null;
  if (answers?.use !== "product") return { set: "general", productPrompt: null };
  return {
    set: "product",
    productPrompt: buildsProduct({ ...answers, product: "have" })
      ? composeOpengeniPrompt(answers)
      : null,
  };
}
