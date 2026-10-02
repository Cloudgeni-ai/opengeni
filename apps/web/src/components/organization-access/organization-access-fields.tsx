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
  type OrganizationActor,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   What an organization key or a connected agent can do, where, and as whom.
   One block shared by the consent page, a connected agent's page and the
   organization API key form, so the same choice reads the same everywhere:

     Acts as        You / the organization          (agents only)
     Access         Read only / Full access / Custom (+ grouped checkboxes)
     Available in   All workspaces, new ones too / Only selected workspaces
   -------------------------------------------------------------------------- */

export type AccessWorkspace = { id: string; name: string; personal?: boolean };

export type ActorChoice = {
  value: OrganizationActor;
  onChange: (next: OrganizationActor) => void;
  /** The person's name, for "You (Maja Berg)". */
  personName: string;
  /** Why acting as the organization isn't offered (not an owner or admin), or null. */
  organizationUnavailableReason: string | null;
};

export function OrganizationAccessFields({
  organizationName,
  actor,
  fixedActor,
  policy,
  onPolicyChange,
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  grantable,
  errors,
  disabled = false,
}: {
  organizationName: string;
  /** Omit for organization API keys, which always act as the organization. */
  actor?: ActorChoice;
  /** Who an existing agent acts as, when that can't change here. */
  fixedActor?: OrganizationActor;
  policy: OrganizationAccessPolicy;
  onPolicyChange: (next: OrganizationAccessPolicy) => void;
  /** Workspaces it could reach; null while loading. Personal ones only show when acting as you. */
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: () => void;
  /** What the person can do themselves: the ceiling when the agent acts as them. */
  grantable?: ReadonlySet<string>;
  errors?: { permissions?: string; workspaces?: string };
  disabled?: boolean;
}) {
  const actsAsYou = (actor?.value ?? fixedActor) === "user";
  const ceilingFor = (asYou: boolean) => (permission: string) =>
    !asYou || !grantable || grantable.has(permission);
  const canGrant = ceilingFor(actsAsYou);
  // Acting as you, a preset means "that much of what you can do", so it always fits.
  const presetAllowed = (preset: Exclude<OrganizationAccessPreset, "custom">) =>
    actsAsYou || presetPermissions(preset).every(canGrant);
  const choosePreset = (next: OrganizationAccessPreset) => {
    if (next === "custom") {
      onPolicyChange({
        ...policy,
        preset: "custom",
        permissions: policy.permissions.filter(canGrant),
      });
      return;
    }
    onPolicyChange({
      ...policy,
      preset: next,
      permissions: presetPermissions(next).filter(
        (permission) => !actsAsYou || canGrant(permission),
      ),
    });
  };
  const visibleWorkspaces =
    workspaces?.filter((workspace) => actsAsYou || !workspace.personal) ?? null;
  const selected = policy.workspaceScope.kind === "selected" ? policy.workspaceScope : null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {actor ? (
        <ChoiceCards
          label="Acts as"
          value={actor.value}
          disabled={disabled}
          onValueChange={(next) => {
            const value = next as OrganizationActor;
            actor.onChange(value);
            const fits = ceilingFor(value === "user");
            const personal = new Set((workspaces ?? []).filter((w) => w.personal).map((w) => w.id));
            onPolicyChange({
              ...policy,
              // A preset keeps its meaning under the new identity.
              permissions:
                policy.preset === "custom"
                  ? policy.permissions.filter(fits)
                  : presetPermissions(policy.preset).filter(fits),
              // The organization can't open anyone's Personal workspace.
              workspaceScope:
                value === "organization" && selected
                  ? {
                      kind: "selected",
                      workspaceIds: selected.workspaceIds.filter((id) => !personal.has(id)),
                    }
                  : policy.workspaceScope,
            });
          }}
        >
          <ChoiceCard
            value="user"
            title={`You (${actor.personName})`}
            description="Uses your own access, including your Personal workspace and private chats. Stops working if you leave or lose access."
          />
          <ChoiceCard
            value="organization"
            title={`The organization (${organizationName})`}
            description="Like an organization API key: keeps working when people change. Can't open Personal workspaces or private chats."
            disabled={actor.organizationUnavailableReason !== null}
            {...(actor.organizationUnavailableReason
              ? { disabledReason: actor.organizationUnavailableReason }
              : {})}
          />
        </ChoiceCards>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4">
        <ChoiceCards
          label="Access"
          value={policy.preset}
          disabled={disabled}
          onValueChange={(next) => choosePreset(next as OrganizationAccessPreset)}
          {...(policy.preset !== "custom" && errors?.permissions
            ? { error: errors.permissions }
            : {})}
        >
          {(["read_only", "full", "custom"] as const).map((preset) => {
            const allowed = preset === "custom" || presetAllowed(preset);
            return (
              <ChoiceCard
                key={preset}
                value={preset}
                title={ACCESS_PRESET_COPY[preset].label}
                description={
                  actsAsYou && preset === "full"
                    ? "Everything you can do yourself, in the workspaces below."
                    : ACCESS_PRESET_COPY[preset].description
                }
                disabled={!allowed}
                {...(allowed
                  ? {}
                  : {
                      disabledReason:
                        "Needs more access than you have. An organization admin can give it.",
                    })}
              />
            );
          })}
        </ChoiceCards>
        {policy.preset === "custom" ? (
          <Field label="Permissions" group error={errors?.permissions}>
            <PermissionChecklist
              selected={policy.permissions}
              canGrant={canGrant}
              disabled={disabled}
              onChange={(permissions) => onPolicyChange({ ...policy, permissions })}
            />
          </Field>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <ChoiceCards
          label="Available in"
          value={policy.workspaceScope.kind}
          disabled={disabled}
          onValueChange={(next) =>
            onPolicyChange({
              ...policy,
              workspaceScope:
                next === "selected" ? { kind: "selected", workspaceIds: [] } : { kind: "all" },
            })
          }
        >
          <ChoiceCard
            value="all"
            title={`All workspaces in ${organizationName}`}
            description={
              actsAsYou
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
            {visibleWorkspaces === null && workspacesError ? (
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
            ) : visibleWorkspaces === null ? (
              <Skeleton className="h-5 w-48 rounded-md" />
            ) : (
              visibleWorkspaces.map((workspace) => (
                <CheckboxField
                  key={workspace.id}
                  label={workspace.personal ? "Your Personal workspace" : workspace.name}
                  disabled={disabled}
                  checked={selected.workspaceIds.includes(workspace.id)}
                  onCheckedChange={(checked) =>
                    onPolicyChange({
                      ...policy,
                      workspaceScope: {
                        kind: "selected",
                        workspaceIds: checked
                          ? [...new Set([...selected.workspaceIds, workspace.id])]
                          : selected.workspaceIds.filter((id) => id !== workspace.id),
                      },
                    })
                  }
                />
              ))
            )}
            {errors?.workspaces ? (
              <p role="alert" className="m-0 text-sm leading-5 text-danger">
                {errors.workspaces}
              </p>
            ) : null}
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}

/** Every permission in groups people recognise; ones beyond your own access stay visible, off. */
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
