import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonalWorkspaceBadge } from "../src/components/personal-workspace-badge";
import { WorkspaceMenuItemContent } from "../src/components/rail/switcher-block";
import {
  WorkspaceScopeMenu,
  WorkspaceScopeNavigationContent,
  type ScopeNavigationLink,
} from "../src/components/rail/workspace-scope-nav";
import { managedSelfContextIdentity } from "../src/lib/managed-self-context";
import type { Workspace } from "../src/types";

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
  const scope = {
    organizationId,
    organizationLabel: "Northstar",
    workspaceId: personalWorkspaceId,
    workspaceLabel: "Roadmap",
    workspaceKind: "personal" as const,
    personalWorkspaceId,
  };
  const links: ScopeNavigationLink[] = [
    {
      href: `/workspaces/${personalWorkspaceId}/organization`,
      label: "Northstar",
      description: "Organization administration",
    },
    {
      href: `/workspaces/${personalWorkspaceId}/settings`,
      label: "Roadmap",
      description: "Personal workspace settings",
    },
    {
      href: `/workspaces/${personalWorkspaceId}/sessions`,
      label: "Personal",
      description: "Current owner-only workspace",
    },
  ];
  const resources: ScopeNavigationLink[] = [
    {
      href: `/workspaces/${personalWorkspaceId}/variable-sets`,
      label: "Variable sets",
      description: "Organization, Workspace, or Only me",
    },
  ];
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
        "section",
        { id: "desktop-scope-navigation" },
        createElement(WorkspaceScopeMenu, {
          scope,
          links,
          resources,
          collapsed: false,
        }),
      ),
      createElement(
        "section",
        { id: "mobile-scope-navigation", style: { width: "320px" } },
        createElement(WorkspaceScopeNavigationContent, {
          scope,
          links,
          resources,
        }),
      ),
    ),
  );
}
