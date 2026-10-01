// Sandbox environments: organization-, workspace-, or user-scoped sandbox
// definitions. An environment is a setup/check layer over the platform sandbox
// image plus default variable sets, versioned and verified. This page lists
// them and creates new ones (?view=new); each environment's own page owns
// versions, changes and promotion.
import { useOpenGeni, useVariableSets } from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { ContainerIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  RigDefinitionFields,
  cleanRigChecks,
  compatibleVariableSets,
  emptyRigDefinitionDraft,
  type RigDefinitionDraft,
} from "@/components/rigs/rig-definition-fields";
import { rigHealth } from "@/components/rigs/rig-health";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { resourceScopeLabel, type ResourceScope } from "@/components/resource-scope-picker";
import { userFacingError } from "@/components/variable-sets/variable-set-model";
import { LoadFailure } from "@/components/variable-sets/variable-set-pages";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import type { CreateRigRequest, Rig } from "@/types";

export const SANDBOX_ENVIRONMENTS_DESCRIPTION =
  "Setup scripts and health checks for the sandboxes your agents work in.";

const COLUMNS: RowListColumn[] = [
  { id: "health", label: "Health", width: 136, hideLabel: true },
  { id: "updated", label: "Updated", width: 96, hideLabel: true },
];

export function RigsRoute({ workspaceId, view }: { workspaceId: string; view?: "new" }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { client } = useOpenGeni();
  const canView = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:use");
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:manage");
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const canManageOrganization = Boolean(
    workspace?.accountId &&
    hasAccountPermission(context.accessContext, workspace.accountId, "account:admin"),
  );
  const canCreatePersonal = Boolean(
    context.managedSelfContext?.identity.subjectId === context.accessContext.subjectId &&
    workspace?.accountId &&
    context.managedSelfContext.memberships.some(
      (membership) =>
        membership.status === "active" && membership.organizationId === workspace.accountId,
    ),
  );
  const organizationName = workspace
    ? orgLabel(workspace.accountId, context.accessContext.accountGrants)
    : "your organization";
  const rigs = useWorkspaceRigs({ enabled: canView });
  const defaultRigId = workspace?.defaultRigId ?? null;

  const openList = (search: { view?: "new" } = {}) =>
    void navigate({ to: "/workspaces/$workspaceId/rigs", params: { workspaceId }, search });
  const openRig = (rigId: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/rigs/$rigId",
      params: { workspaceId, rigId },
    });

  if (view === "new" && canView && canManage) {
    return (
      <ContentPage width="standard">
        <NewRigPage
          organizationName={organizationName}
          organizationEnabled={canManageOrganization}
          personalEnabled={canCreatePersonal}
          onClose={() => openList()}
          onCreate={async (request) => {
            let created: Rig;
            try {
              created = await client.createRig(workspaceId, request);
            } catch (error) {
              throw userFacingError(error);
            }
            toast.success(`Created ${created.name}`);
            openRig(created.id);
            void rigs.refresh();
          }}
        />
      </ContentPage>
    );
  }

  const empty = canView && !rigs.loading && !rigs.error && rigs.rigs.length === 0;
  const newButton = (
    <Button type="button" onClick={() => openList({ view: "new" })} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      New environment
    </Button>
  );

  let body;
  if (!canView) {
    body = <PermissionDenied />;
  } else if (rigs.loading && rigs.rigs.length === 0) {
    body = (
      <RowList label="Sandbox environments" columns={COLUMNS} flush busy>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  } else if (rigs.error && rigs.rigs.length === 0) {
    body = (
      <LoadFailure
        title="Couldn't load sandbox environments"
        error={rigs.error}
        onRetry={() => void rigs.refresh()}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<ContainerIcon />}
        title="No sandbox environments yet"
        description={
          canManage
            ? "Install tools and check that everything is ready before your agents start work."
            : "Someone who can manage sandbox environments can add one here."
        }
        action={canManage ? newButton : undefined}
      />
    );
  } else {
    body = (
      <RowList label="Sandbox environments" columns={COLUMNS} flush>
        {rigs.rigs.map((rig) => (
          <RigRow
            key={rig.id}
            rig={rig}
            isDefault={rig.id === defaultRigId}
            onOpen={() => openRig(rig.id)}
          />
        ))}
      </RowList>
    );
  }

  return (
    <ContentPage width="standard">
      <div className="min-w-0 pb-7">
        <PageHeader
          title="Sandbox environments"
          description={SANDBOX_ENVIRONMENTS_DESCRIPTION}
          actions={canView && canManage && !empty ? newButton : undefined}
        />
        <div className="min-w-0 pt-6">{body}</div>
      </div>
    </ContentPage>
  );
}

export function PermissionDenied() {
  return (
    <EmptyState
      variant="page"
      icon={<ContainerIcon />}
      title="You don't have access to sandbox environments"
      description="Ask a workspace admin for the Sandbox environments permission to view environments and propose changes."
    />
  );
}

function RigRow({ rig, isDefault, onOpen }: { rig: Rig; isDefault: boolean; onOpen: () => void }) {
  const health = rigHealth(rig);
  return (
    <ListRow
      leading={<LogoTile icon={<ContainerIcon />} />}
      title={rig.name}
      titleAddon={
        <>
          {isDefault ? (
            <MetaChip title="New sessions in this workspace use it">Default</MetaChip>
          ) : null}
          {rig.scope !== "workspace" ? <RigScopeChip scope={rig.scope} /> : null}
        </>
      }
      description={rig.description || undefined}
      cells={{
        health: (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <StatusDot tone={health.tone} size="sm" />
            <span className="truncate">{health.label}</span>
          </span>
        ),
        updated: <RelativeTime date={rig.updatedAt} />,
      }}
      indicator="open"
      onOpen={onOpen}
    />
  );
}

export function RigScopeChip({ scope }: { scope: Rig["scope"] }) {
  const label = resourceScopeLabel(scope);
  return (
    <span data-rig-scope={scope}>
      <MetaChip title={`${label} access`}>{label}</MetaChip>
    </span>
  );
}

function NewRigPage({
  organizationName,
  organizationEnabled,
  personalEnabled,
  onClose,
  onCreate,
}: {
  organizationName: string;
  organizationEnabled: boolean;
  personalEnabled: boolean;
  onClose: () => void;
  /** Saves the environment and opens it. Throws a user-facing error. */
  onCreate: (request: CreateRigRequest) => Promise<void>;
}) {
  const variableSets = useVariableSets();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<ResourceScope>("workspace");
  const [definition, setDefinition] = useState<RigDefinitionDraft>(emptyRigDefinitionDraft());
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const checks = cleanRigChecks(definition.checks);
  const summaryParts = [
    definition.setupScript.trim() ? "Setup script" : null,
    checks.length ? `${checks.length} ${checks.length === 1 ? "check" : "checks"}` : null,
    definition.defaultVariableSetIds.length
      ? `${definition.defaultVariableSetIds.length} variable ${
          definition.defaultVariableSetIds.length === 1 ? "set" : "sets"
        }`
      : null,
  ].filter(Boolean);

  const scopeHint =
    scope === "organization"
      ? `Every workspace in ${organizationName} can use it. Only organization admins can change it.`
      : scope === "user"
        ? "Only you can use it, in any workspace."
        : "Everyone in this workspace can use it.";

  return (
    <FlushFormPage
      backLabel="Sandbox environments"
      onClose={onClose}
      title="New sandbox environment"
      submitLabel="Create environment"
      pendingLabel="Creating…"
      onSubmit={async () => {
        setTried(true);
        if (!trimmed) return false;
        await onCreate({
          scope,
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(definition.setupScript.trim() ? { setupScript: definition.setupScript } : {}),
          checks,
          credentialHooks: [],
          defaultVariableSetIds: definition.defaultVariableSetIds,
        });
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={tried && !trimmed ? "Name the environment." : undefined}>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Web app with Node 22"
            suppressAutofill
            autoComplete="off"
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Node, pnpm and Playwright browsers"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Available to"
          group
          hint={
            <>
              {scopeHint} <span className="text-fg">You can't change this later.</span>
            </>
          }
        >
          <SegmentedControl
            fullWidth
            className="max-w-[440px]"
            value={scope}
            onValueChange={(nextScope) => {
              setScope(nextScope);
              // Keep only default sets an environment of the new scope may use.
              const allowed = new Set(
                compatibleVariableSets(variableSets.variableSets, nextScope).map((set) => set.id),
              );
              setDefinition((current) => ({
                ...current,
                defaultVariableSetIds: current.defaultVariableSetIds.filter((id) =>
                  allowed.has(id),
                ),
              }));
            }}
            options={[
              { value: "workspace", label: "Workspace" },
              {
                value: "organization",
                label: "Organization",
                disabled: !organizationEnabled,
                disabledReason: "Only organization admins can create organization environments.",
              },
              {
                value: "user",
                label: "Only me",
                disabled: !personalEnabled,
                disabledReason: "Personal environments need a signed-in organization member.",
              },
            ]}
          />
        </Field>
        <Disclosure
          title="Setup and checks"
          summary={
            summaryParts.length
              ? summaryParts.join(" · ")
              : "Optional. You can add these later as verified changes."
          }
        >
          <RigDefinitionFields
            value={definition}
            onChange={setDefinition}
            variableSets={variableSets.variableSets}
            rigScope={scope}
            idPrefix="create-rig"
          />
        </Disclosure>
      </FieldStack>
    </FlushFormPage>
  );
}
