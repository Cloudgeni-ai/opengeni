// The organization's per-person limit on Personal-workspace spending, against
// an in-memory client: Organization settings > Billing's control, and below it
// the owner's Usage page in a Personal workspace that has spent its limit.
// `?limit=` (dollars, empty for none) sets the control's starting limit; the
// usage page always shows a spent $50 limit. Saves land on window.
import { createRoot } from "react-dom/client";

import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { Toaster } from "@opengeni/react/app/components/toaster";
import type { OrganizationPrivacySettings } from "@opengeni/react/app/types";
import { SectionStack } from "@opengeni/react/ui/section";
import { SectionVariantProvider } from "@opengeni/react/ui/section-variant";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { PersonalWorkspaceLimitSection } from "../src/components/usage/personal-workspace-limit-section";
import { WorkspaceUsagePage } from "../src/components/usage/workspace-usage-page";
import "../src/styles.css";

declare global {
  interface Window {
    personalLimitSaves: unknown[];
  }
}
window.personalLimitSaves = [];

const organizationId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:owner";
const startingDollars = new URL(window.location.href).searchParams.get("limit");
const limit = 50_000_000;

let privacy: OrganizationPrivacySettings = {
  organizationId,
  defaultVisibility: "workspace",
  personalWorkspaces: true,
  personalWorkspaceMonthlyCredits:
    startingDollars === null
      ? limit
      : startingDollars === ""
        ? null
        : Number(startingDollars) * 1_000_000,
  adminsSeePrivateSchedules: true,
  limits: {
    onlyMeAllowed: true,
    defaultVisibilityLocked: false,
    adminsSeePrivateSchedulesLocked: false,
  },
  updatedAt: null,
};
const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 250));
const resetsAt = "2026-12-01T00:00:00.000Z";

const client = {
  getOrganizationPrivacySettings: async () => later(privacy),
  updateOrganizationPrivacySettings: async (_organizationId: string, change: object) => {
    window.personalLimitSaves.push(change);
    privacy = { ...privacy, ...change };
    return later(privacy);
  },
  // The owner's own usage in their Personal workspace: the whole limit spent.
  requestJson: async () =>
    later({
      unit: "usd_micros",
      period: { start: "2026-11-01T00:00:00.000Z", end: resetsAt },
      workspace: {
        limit,
        used: limit,
        remaining: 0,
        fraction: 1,
        status: "exhausted",
        resetsAt,
        includedCredits: limit,
        grantsRemaining: 0,
      },
      members: [
        {
          subjectId,
          externalIdentity: null,
          rule: null,
          version: 0,
          limit: null,
          used: limit,
          remaining: null,
          fraction: null,
          status: "ok",
          resetsAt: null,
        },
      ],
      nextCursor: null,
    }),
  listWorkspaceMembers: async () => [],
};

const appContext = {
  client,
  accessContext: {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId: organizationId, permissions: ["account:read"] }],
    workspaceGrants: [{ workspaceId, accountId: organizationId, permissions: ["workspace:read"] }],
  },
} as unknown as AppContextValue;

createRoot(document.getElementById("root")!).render(
  <AppContext.Provider value={appContext}>
    <TooltipProvider>
      <SectionVariantProvider variant="group">
        <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6">
          <PersonalWorkspaceLimitSection organizationId={organizationId} />
          <SectionStack>
            <WorkspaceUsagePage
              workspaceId={workspaceId}
              workspaceName="Personal"
              organizationId={organizationId}
              personalOrganizationLabel="Acme"
            />
          </SectionStack>
        </main>
      </SectionVariantProvider>
    </TooltipProvider>
    <Toaster />
  </AppContext.Provider>,
);
