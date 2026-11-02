import { useState } from "react";
import type { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/sdk";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useConsoleSharedQueries } from "@opengeni/react/app/lib/shared-query";
import { SettingRowGroup } from "@opengeni/react/ui/setting-row";
import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import { organization, workspaces } from "../fixtures";
import { KitBlock, KitCanvas, KitSection } from "../kit";

const [owner, platform, success, finance] = workspaces as [
  (typeof workspaces)[number],
  (typeof workspaces)[number],
  (typeof workspaces)[number],
  (typeof workspaces)[number],
];

type Scenario = {
  /** The organization's page, or the page of the workspace that owns the account. */
  organization: boolean;
  /** The workspaces the page offers: on a workspace's page, the ones this person administers. */
  offered: Array<{ id: string; name: string }>;
  served: string[];
};

/**
 * A workspace's own subscription account keeps its owner when its admins share
 * it with other workspaces they administer (D-52). Production access rows and
 * form; only the SDK transport is an in-memory fixture, and saves stay local.
 */
export default function ModelsSharingSection() {
  return (
    <KitSection sectionKey="page-models-sharing">
      <KitBlock
        title="At its workspace"
        description="Design preview's admins share its own account with Platform engineering, a workspace they also administer. It stays Design preview's."
      >
        <Preview
          scenario={{
            organization: false,
            offered: [owner, platform, success],
            served: [owner.id, platform.id],
          }}
        />
      </KitBlock>
      <KitBlock
        title="At its workspace, administering no other"
        description="Nothing else to offer: the form says where sharing comes from."
      >
        <Preview scenario={{ organization: false, offered: [owner], served: [owner.id] }} />
      </KitBlock>
      <KitBlock
        title="On the organization's page"
        description="Owners and admins can share it with any shared workspace and it stays Design preview's. Choose all shared workspaces, Personal workspaces or people to see the move."
      >
        <Preview
          scenario={{
            organization: true,
            offered: [owner, platform, success, finance],
            served: [owner.id, platform.id],
          }}
        />
      </KitBlock>
    </KitSection>
  );
}

function Preview({ scenario }: { scenario: Scenario }) {
  // One client per pane: Side by side renders each preview twice.
  const [client] = useState(() => fixtureClient(scenario));
  useConsoleSharedQueries(client);
  const access = useConnectionAccess(
    scenario.organization
      ? {
          client,
          organizationId: organization.id,
          kind: "claude_subscription",
          connectionId: "team-claude",
        }
      : { client, workspaceId: owner.id, kind: "claude_subscription", connectionId: "team-claude" },
  );
  return (
    <div className="grid min-w-0 gap-4">
      <KitCanvas>
        <SettingRowGroup>
          <ConnectionAccessRows
            access={access}
            organization={scenario.organization}
            canManage
            onEdit={() => undefined}
          />
        </SettingRowGroup>
      </KitCanvas>
      <KitCanvas>
        <ConnectionAccessFormPage
          access={access}
          organization={scenario.organization}
          canManage
          name="Team Claude"
          onClose={() => undefined}
        />
      </KitCanvas>
    </div>
  );
}

function fixtureClient(scenario: Scenario) {
  let policy: ModelConnectionAccessPolicy = {
    allowedModels: null,
    allowedWorkspaces: scenario.served,
    allowPersonalWorkspaces: false,
    version: 1,
  };
  const response = (): ModelConnectionAccessResponse => ({
    policy,
    models: [
      { id: "claude-subscription/claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-subscription/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    ],
    workspaces: scenario.offered.map(({ id, name }) => ({ id, name })),
    personalWorkspacesSupported: scenario.organization,
    peopleSupported: scenario.organization,
    ...(scenario.organization
      ? {
          people: [
            { id: "person-ada", name: "Ada Lindqvist", email: "ada@acme.example" },
            { id: "person-sam", name: null, email: "sam@acme.example" },
          ],
        }
      : {}),
    localWorkspaceIds: [owner.id],
    managedByWorkspaceId: owner.id,
  });
  return Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://ui-kit.invalid" }), {
    requestJson: async (method: string, _path: string, body?: ModelConnectionAccessPolicy) => {
      if (method === "PUT" && body) {
        const { moveToOrganization: _move, sharePersonal: _share, ...saved } = body;
        policy = { ...saved, version: policy.version + 1 };
        return policy;
      }
      return response();
    },
  });
}
