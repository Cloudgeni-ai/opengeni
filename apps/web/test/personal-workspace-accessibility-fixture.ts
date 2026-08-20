import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonalWorkspaceBadge } from "../src/components/personal-workspace-badge";
import { WorkspaceMenuItemContent } from "../src/components/rail/switcher-block";
import { SessionTenancyControl } from "../src/components/session/session-tenancy-control";
import { managedSelfContextIdentity } from "../src/lib/managed-self-context";
import { SessionTenancyOperationController } from "../src/lib/session-tenancy-operation-controller";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { Session, Workspace } from "../src/types";

const organizationId = "11111111-1111-4111-8111-111111111111";
const personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspace: Workspace = {
  id: personalWorkspaceId,
  accountId: organizationId,
  name: "Roadmap",
  slug: null,
  externalSource: null,
  externalId: null,
  agentInstructions: null,
  settings: {},
  inferenceControl: {
    state: "paused",
    revision: 3,
    reason: null,
    changedBy: null,
    changedAt: "2026-08-20T08:00:00.000Z",
  },
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
};
const selfContext = {
  identity: managedSelfContextIdentity({
    credentialGeneration: 7,
    managedUserId: "managed-user",
  }),
  memberships: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId,
      status: "active" as const,
      personalWorkspaceId,
    },
  ],
};

export function renderPersonalWorkspaceAccessibilityFixture(): string {
  return renderToStaticMarkup(
    createElement(
      "main",
      null,
      createElement("div", { id: "personal-badge" }, createElement(PersonalWorkspaceBadge)),
      createElement(
        "div",
        { id: "personal-menuitem", role: "menuitem" },
        createElement(WorkspaceMenuItemContent, {
          workspace: personalWorkspace,
          activeWorkspaceId: "another-workspace",
          managedSelfContext: selfContext,
        }),
      ),
      createElement(
        "div",
        { id: "personal-session-tenancy" },
        createElement(SessionTenancyControl, {
          session: {
            id: "44444444-4444-4444-8444-444444444444",
            workspaceId: personalWorkspaceId,
            accountId: organizationId,
            status: "idle",
            initialMessage: "Review the private workspace boundary",
            title: "Private workspace review",
            titleSource: "user",
            tenancy: {
              visibility: "private",
              authorityEpoch: 3,
              ownedByCurrentUser: true,
              fork: null,
            },
          } as Session,
          client: {} as OpenGeniCoreClient,
          managedSession: true,
          scopeLabel: "Roadmap Personal workspace",
          captureWorkspaceInvocation: () => null,
          ownsWorkspaceInvocation: () => false,
          operationController: new SessionTenancyOperationController(),
          operationScope: {
            principalId: "33333333-3333-4333-8333-333333333333",
            workspaceId: personalWorkspaceId,
            sessionId: "44444444-4444-4444-8444-444444444444",
            workspaceTransitionRevision: 1,
          },
          onRefreshSession: async () => undefined,
          onOpenSession: () => undefined,
        }),
      ),
    ),
  );
}
