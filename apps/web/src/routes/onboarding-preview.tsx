import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import { OrganizationOnboardingPanel } from "@/components/organization-onboarding-panel";
import { SetupAccountRoute } from "@/routes/setup-account";

/** Public development-only harness rendering the production onboarding components. */
export function OnboardingPreviewRoute() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "setup") {
    return <SetupAccountRoute token="approval-preview-token-not-submitted" />;
  }
  if (view === "organization") {
    return <OrganizationOnboardingPanel previewState="required" onComplete={() => undefined} />;
  }
  return <ManagedAuthPanel initialMode="signup" onSubmit={async () => undefined} />;
}
