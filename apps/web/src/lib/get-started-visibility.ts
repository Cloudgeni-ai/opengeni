import { useAppContext } from "@/context";

import { onboardingJourneyStorageKey, useOnboardingJourney } from "./onboarding-journey";

/**
 * Whether the Get started card belongs on this workspace's new-chat page: a
 * first-run journey in its organization that the person hasn't hidden. Reads
 * this browser's storage only, so the page can decide before loading the card.
 */
export function useGetStartedCardVisible(workspaceId: string): boolean {
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
  return Boolean(journey && !journey.checklistDismissed);
}
