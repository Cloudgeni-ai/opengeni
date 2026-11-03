import { useState } from "react";

import {
  WorkspaceReachFields,
  type ReachExtraChoice,
  type ReachOwner,
  type ReachPersonalWorkspaces,
  type ReachWorkspace,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { CheckboxField } from "@opengeni/react/ui/field";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   The "Available in" control, rendered for real for each owner: an
   organization thing, a workspace's thing and your own thing, plus the long,
   loading and failed workspace lists and a model account's "Only selected
   people". Every control works; nothing is saved.
   -------------------------------------------------------------------------- */

const ORGANIZATION = "Acme Robotics";
const SHARED: ReachWorkspace[] = [
  { id: "design", name: "Design preview" },
  { id: "support", name: "Customer support and operations, Northern Europe" },
  { id: "finance", name: "Finance" },
];
const MANY: ReachWorkspace[] = [
  ...SHARED,
  ...["Legal", "Platform", "Research", "Sales", "Marketing", "Hiring", "Security"].map((name) => ({
    id: name.toLowerCase(),
    name,
  })),
];

function Live({
  owner,
  initial,
  personalWorkspaces,
  workspaces = SHARED,
  managedBy,
  extra = false,
  workspacesError = false,
  hereId = "design",
}: {
  owner: ReachOwner;
  initial: WorkspaceReach;
  personalWorkspaces: ReachPersonalWorkspaces;
  workspaces?: ReachWorkspace[] | null;
  managedBy?: string;
  extra?: boolean;
  workspacesError?: boolean;
  hereId?: string | null;
}) {
  const [value, setValue] = useState(initial);
  const [people, setPeople] = useState<string[] | null>(null);
  const extraChoice: ReachExtraChoice | undefined = extra
    ? {
        value: "people",
        title: "Only selected people",
        description: "Only their own chats and automations.",
        chosen: people !== null,
        onChoose: () => setPeople([]),
        content: (
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg">People</legend>
            {["Maja Berg", "Alex Morgan"].map((name) => (
              <CheckboxField
                key={name}
                label={name}
                checked={people?.includes(name) ?? false}
                onCheckedChange={(checked) =>
                  setPeople((now) =>
                    checked ? [...(now ?? []), name] : (now ?? []).filter((each) => each !== name),
                  )
                }
              />
            ))}
          </fieldset>
        ),
      }
    : undefined;
  return (
    <div className="w-full max-w-[560px] text-left">
      <WorkspaceReachFields
        owner={owner}
        organizationName={ORGANIZATION}
        {...(managedBy ? { managedBy } : {})}
        value={value}
        onChange={(next) => {
          setPeople(null);
          setValue(next);
        }}
        workspaces={workspaces}
        workspacesError={workspacesError}
        onRetryWorkspaces={() => undefined}
        hereId={hereId}
        seedSelected={() => (hereId ? [hereId] : [])}
        personalWorkspaces={personalWorkspaces}
        extraChoice={extraChoice}
      />
    </div>
  );
}

export default function WorkspaceReachSection() {
  return (
    <KitSection sectionKey="workspace-reach">
      <StatesGrid
        title="By owner"
        description="The owner line says who it belongs to and who manages it. A workspace's thing always works there; your own thing always works in your Personal workspace."
        columns={2}
      >
        <StateCell label="Organization" align="stretch">
          <Live
            owner={{ kind: "organization", name: ORGANIZATION }}
            managedBy="Organization owners and admins manage it."
            initial={{ workspaceIds: ["design"], personalWorkspaces: true }}
            personalWorkspaces="choice"
          />
        </StateCell>
        <StateCell label="Workspace" align="stretch">
          <Live
            owner={{ kind: "workspace", id: "design", name: "Design preview" }}
            managedBy="Only organization owners can change where it works."
            initial={{ workspaceIds: ["finance"], personalWorkspaces: false }}
            personalWorkspaces="none"
            hereId={null}
          />
        </StateCell>
        <StateCell label="Only me" align="stretch">
          <Live
            owner={{ kind: "person" }}
            initial={{ workspaceIds: null, personalWorkspaces: true }}
            personalWorkspaces="always"
          />
        </StateCell>
      </StatesGrid>
      <StatesGrid
        title="Lists"
        description="Long lists search; loading and failures stay in place."
        columns={2}
      >
        <StateCell label="Long list" align="stretch">
          <Live
            owner={{ kind: "organization", name: ORGANIZATION }}
            managedBy="Organization owners and admins manage it."
            initial={{ workspaceIds: ["design", "legal"], personalWorkspaces: false }}
            personalWorkspaces="choice"
            workspaces={MANY}
          />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <Live
            owner={{ kind: "organization", name: ORGANIZATION }}
            initial={{ workspaceIds: [], personalWorkspaces: false }}
            personalWorkspaces="choice"
            workspaces={null}
          />
        </StateCell>
        <StateCell label="Couldn't load" align="stretch">
          <Live
            owner={{ kind: "organization", name: ORGANIZATION }}
            initial={{ workspaceIds: [], personalWorkspaces: false }}
            personalWorkspaces="choice"
            workspaces={null}
            workspacesError
          />
        </StateCell>
        <StateCell label="Selected people" align="stretch">
          <Live
            owner={{ kind: "organization", name: ORGANIZATION }}
            managedBy="Organization owners and admins manage it."
            initial={{ workspaceIds: null, personalWorkspaces: true }}
            personalWorkspaces="choice"
            extra
          />
        </StateCell>
      </StatesGrid>
    </KitSection>
  );
}
