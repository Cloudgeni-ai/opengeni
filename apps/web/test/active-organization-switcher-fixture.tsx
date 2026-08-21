import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  OrganizationSwitcherLine,
  WorkspaceSwitcherTrigger,
} from "../src/components/rail/switcher-block";
import { orgLabel, type OrgOption } from "../src/lib/org";
import type { Workspace } from "../src/types";
import "../src/styles.css";

const firstAccountId = "11111111-1111-4111-8111-111111111111";
const secondAccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const organizations: OrgOption[] = [firstAccountId, secondAccountId].map((accountId) => ({
  accountId,
  label: orgLabel(accountId, []),
  canManage: false,
}));

function workspace(id: string, accountId: string, name: string): Workspace {
  return {
    id,
    accountId,
    name,
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 1,
      reason: null,
      changedBy: null,
      changedAt: "2026-08-20T08:00:00.000Z",
    },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
  };
}

const workspaces = new Map([
  [firstAccountId, workspace("workspace-one", firstAccountId, "Atlas")],
  [secondAccountId, workspace("workspace-two", secondAccountId, "Beacon")],
]);

function ActiveOrganizationSwitcherFixture() {
  const [activeAccountId, setActiveAccountId] = useState(firstAccountId);
  const activeOrganization = organizations.find(
    (organization) => organization.accountId === activeAccountId,
  )!;
  const activeWorkspace = workspaces.get(activeAccountId)!;

  return (
    <main className="grid max-w-72 gap-8 p-6">
      <section id="expanded-org-switcher" aria-label="Expanded organization switcher">
        <OrganizationSwitcherLine
          orgs={organizations}
          currentLabel={activeOrganization.label}
          activeAccountId={activeAccountId}
          onSelect={setActiveAccountId}
          workspaceId={null}
        />
      </section>
      <section id="collapsed-org-switcher" aria-label="Collapsed organization switcher">
        <WorkspaceSwitcherTrigger
          activeWorkspace={activeWorkspace}
          activeOrganizationLabel={activeOrganization.label}
          personal={false}
          collapsed
        />
      </section>
      <output data-testid="active-account-id">{activeAccountId}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ActiveOrganizationSwitcherFixture />);
