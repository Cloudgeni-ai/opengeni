import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { CheckboxField, Field } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ACCESS_PRESET_COPY,
  ORGANIZATION_PERMISSION_GROUPS,
  organizationPermissionLabel,
  presetPermissions,
  type OrganizationAccessPolicy,
  type OrganizationAccessPreset,
  type OrganizationWorkspaceScope,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   What an organization key or a connected agent can do, and where. One block
   shared by the agent sign-in page, a connected agent's page and the
   organization API key form, so the same choice reads the same everywhere:

     Access         Read only / Full access / Custom (+ grouped checkboxes)
     Available in   All workspaces, new ones too / Only selected workspaces

   For an agent acting as a person, `ceiling` is what that person can do:
   permissions beyond it stay visible but off, and the server caps the rest.
   -------------------------------------------------------------------------- */

export type AccessWorkspace = { id: string; name: string; personal?: boolean };

export function OrganizationAccessFields({
  organizationName,
  policy,
  onPolicyChange,
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  ceiling,
  includesPersonal = false,
  errors,
  disabled = false,
}: {
  organizationName: string;
  policy: OrganizationAccessPolicy;
  onPolicyChange: (next: OrganizationAccessPolicy) => void;
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: () => void;
  /** What the person can do themselves, when the agent acts as them. */
  ceiling?: ReadonlySet<string>;
  /** Acting as a person reaches their Personal workspace too. */
  includesPersonal?: boolean;
  errors?: { permissions?: string; workspaces?: string };
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <AccessPresetFields
        policy={policy}
        onPolicyChange={onPolicyChange}
        {...(ceiling ? { ceiling } : {})}
        {...(errors?.permissions ? { error: errors.permissions } : {})}
        actsAsPerson={includesPersonal}
        disabled={disabled}
      />
      <WorkspaceScopeFields
        organizationName={organizationName}
        scope={policy.workspaceScope}
        onScopeChange={(workspaceScope) => onPolicyChange({ ...policy, workspaceScope })}
        workspaces={
          includesPersonal
            ? workspaces
            : (workspaces?.filter((workspace) => !workspace.personal) ?? null)
        }
        workspacesError={workspacesError}
        {...(onRetryWorkspaces ? { onRetryWorkspaces } : {})}
        includesPersonal={includesPersonal}
        {...(errors?.workspaces ? { error: errors.workspaces } : {})}
        disabled={disabled}
      />
    </div>
  );
}

/** Read only, Full access or Custom; Custom reveals the grouped checklist. */
export function AccessPresetFields({
  policy,
  onPolicyChange,
  ceiling,
  actsAsPerson = false,
  error,
  disabled = false,
}: {
  policy: OrganizationAccessPolicy;
  onPolicyChange: (next: OrganizationAccessPolicy) => void;
  ceiling?: ReadonlySet<string>;
  actsAsPerson?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const canGrant = (permission: string) => !ceiling || ceiling.has(permission);
  const choose = (next: OrganizationAccessPreset) =>
    onPolicyChange(
      next === "custom"
        ? { ...policy, preset: "custom", permissions: policy.permissions.filter(canGrant) }
        : // A preset is stored whole; acting as a person, the server caps it by
          // their live access, so "Full access" keeps meaning "all you can do".
          { ...policy, preset: next, permissions: presetPermissions(next) },
    );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ChoiceCards
        label="Access"
        value={policy.preset}
        disabled={disabled}
        onValueChange={(next) => choose(next as OrganizationAccessPreset)}
        {...(policy.preset !== "custom" && error ? { error } : {})}
      >
        {(["full", "read_only", "custom"] as const).map((preset) => (
          <ChoiceCard
            key={preset}
            value={preset}
            title={ACCESS_PRESET_COPY[preset].label}
            description={
              actsAsPerson && preset === "full"
                ? "Everything you can do yourself, including people, keys, billing and secret values."
                : ACCESS_PRESET_COPY[preset].description
            }
          />
        ))}
      </ChoiceCards>
      {policy.preset === "custom" ? (
        <Field label="Permissions" group error={error}>
          <PermissionChecklist
            selected={policy.permissions}
            canGrant={canGrant}
            disabled={disabled}
            onChange={(permissions) =>
              onPolicyChange({ ...policy, permissions: permissions as typeof policy.permissions })
            }
          />
        </Field>
      ) : null}
    </div>
  );
}

/** "All workspaces, new ones too" or a picked list. */
export function WorkspaceScopeFields({
  organizationName,
  scope,
  onScopeChange,
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  includesPersonal = false,
  error,
  disabled = false,
}: {
  organizationName: string;
  scope: OrganizationWorkspaceScope;
  onScopeChange: (next: OrganizationWorkspaceScope) => void;
  /** Workspaces it could reach; null while loading. */
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: () => void;
  includesPersonal?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const selected = scope.kind === "selected" ? scope : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceCards
        label="Available in"
        value={scope.kind}
        disabled={disabled}
        onValueChange={(next) =>
          onScopeChange(
            next === "selected" ? { kind: "selected", workspaceIds: [] } : { kind: "all" },
          )
        }
      >
        <ChoiceCard
          value="all"
          title={`All workspaces in ${organizationName}`}
          description={
            includesPersonal
              ? "Every workspace you can open, including new ones and your Personal workspace."
              : "Every shared workspace, including new ones."
          }
        />
        <ChoiceCard
          value="selected"
          title="Only selected workspaces"
          description="Workspaces added later aren't included."
        />
      </ChoiceCards>
      {selected ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">Workspaces</legend>
          {workspaces === null && workspacesError ? (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <p className="m-0 text-sm leading-5 text-fg-muted">
                Couldn't load the organization's workspaces.
              </p>
              {onRetryWorkspaces ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetryWorkspaces}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : workspaces === null ? (
            <Skeleton className="h-5 w-48 rounded-md" />
          ) : (
            workspaces.map((workspace) => (
              <CheckboxField
                key={workspace.id}
                label={workspace.personal ? "Your Personal workspace" : workspace.name}
                disabled={disabled}
                checked={selected.workspaceIds.includes(workspace.id)}
                onCheckedChange={(checked) =>
                  onScopeChange({
                    kind: "selected",
                    workspaceIds: checked
                      ? [...new Set([...selected.workspaceIds, workspace.id])]
                      : selected.workspaceIds.filter((id) => id !== workspace.id),
                  })
                }
              />
            ))
          )}
          {error ? (
            <p role="alert" className="m-0 text-sm leading-5 text-danger">
              {error}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

/** Every permission in groups people recognise; ones beyond the ceiling stay visible, off. */
export function PermissionChecklist({
  selected,
  canGrant,
  disabled = false,
  onChange,
}: {
  selected: readonly string[];
  canGrant: (permission: string) => boolean;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="@container/permissions min-w-0">
      <div className="grid min-w-0 gap-x-6 gap-y-6 @[34rem]/permissions:grid-cols-2">
        {ORGANIZATION_PERMISSION_GROUPS.map((group) => (
          <fieldset key={group.label} className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg">
              {group.label}
            </legend>
            <div className="flex min-w-0 flex-col gap-3">
              {group.permissions.map((permission) => {
                const allowed = canGrant(permission);
                return (
                  <CheckboxField
                    key={permission}
                    label={organizationPermissionLabel(permission)}
                    description={
                      <span className="font-mono">
                        {permission}
                        {allowed ? null : (
                          <span className="font-sans"> · beyond your own access</span>
                        )}
                      </span>
                    }
                    checked={allowed && selected.includes(permission)}
                    disabled={disabled || !allowed}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...new Set([...selected, permission])]
                          : selected.filter((each) => each !== permission),
                      )
                    }
                  />
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
