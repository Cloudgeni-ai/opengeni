import { useEffect, useRef } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import type { AppContextValue } from "@/context";
import {
  newOnboardingJourney,
  onboardingJourneyStorageKey,
  writeOnboardingJourney,
} from "@/lib/onboarding-journey";
import type { OnboardingCompletion } from "@/lib/onboarding-paths";

/**
 * Development only (`?onboarding=restart`): forget this browser's Get started
 * progress and first-run answers in the current organization, and open first
 * run again from its first question, in the app.
 */
export function OnboardingRestart({
  appContext,
  pathname,
  onDone,
}: {
  appContext: AppContextValue;
  pathname: string;
  onDone: (next: OnboardingCompletion) => void;
}) {
  const { accessContext, workspaces } = appContext;
  const routeWorkspaceId = /^\/workspaces\/([^/]+)/u.exec(pathname)?.[1] ?? null;
  const current =
    workspaces.find((workspace) => workspace.id === routeWorkspaceId) ??
    workspaces.find((workspace) => workspace.id === accessContext.defaultWorkspaceId) ??
    null;
  const organizationId = current?.accountId ?? accessContext.defaultAccountId;
  const personal = workspaces.find(
    (workspace) => workspace.accountId === organizationId && workspace.kind === "personal",
  );
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !organizationId || !personal) return;
    done.current = true;
    writeOnboardingJourney(
      onboardingJourneyStorageKey(accessContext.subjectId, organizationId),
      newOnboardingJourney(),
    );
    onDone({ to: `/workspaces/${personal.id}/first-agent` });
  }, [accessContext.subjectId, onDone, organizationId, personal]);
  if (!organizationId || !personal)
    return (
      <ProblemPanel
        title="Nothing to replay"
        description="Replay needs an organization with your Personal workspace in it."
      />
    );
  return <LoadingPanel />;
}
