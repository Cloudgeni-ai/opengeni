import type { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@opengeni/react/app/components/models/models-ui";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { ErrorMessage, TechnicalDetails } from "@opengeni/react/ui/error-message";
import { CheckboxField, FieldStack } from "@opengeni/react/ui/field";
import { Notice } from "@opengeni/react/ui/notice";
import { SettingNavRow, SettingRow } from "@opengeni/react/ui/setting-row";
import {
  notifyModelConnectionsChanged,
  MODEL_SETTINGS_STALE_TIME_MS,
  sharedQueryWriter,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";
import { ModelSettingsPlaceholder } from "@opengeni/react/app/components/models/model-settings-placeholder";
import {
  WorkspaceReachFields,
  workspaceReachSummary,
} from "@opengeni/react/app/components/workspace-reach";
import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorTechnicalFacts,
  isPermissionDenied,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";

/* ----------------------------------------------------------------------------
   What one model connection can serve: its models, and at organization scope
   the workspaces that may use it. A summary row on the account's page opens a
   form page to change it.
   -------------------------------------------------------------------------- */

export type ConnectionAccessKind =
  | "codex"
  | "supergrok"
  | "vercel_gateway"
  | "openrouter"
  | "opper"
  | "openai"
  | "azure_openai"
  | "anthropic"
  | "claude_subscription";

export interface ConnectionAccessTarget {
  client: OpenGeniBrowserClient;
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
  kind: ConnectionAccessKind;
  connectionId: string;
  /** Load only when true (default). */
  enabled?: boolean | undefined;
}

export function useConnectionAccess(props: ConnectionAccessTarget) {
  const { client } = props;
  const target = useMemo(
    () => ({
      scope: props.organizationId ? ("organizations" as const) : ("workspaces" as const),
      scopeId: props.organizationId ?? props.workspaceId!,
      kind: props.kind,
      connectionId: props.connectionId,
    }),
    [props.organizationId, props.workspaceId, props.kind, props.connectionId],
  );
  const enabled = props.enabled ?? true;
  const key = useMemo(
    () =>
      [
        "model-settings",
        "access",
        target.scope,
        target.scopeId,
        target.kind,
        target.connectionId,
      ] as const,
    [target],
  );
  const query = useSharedQuery<ModelConnectionAccessResponse>(
    client,
    [...key],
    () => client.getModelConnectionAccess(target),
    { enabled, staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  const current = query.data;
  /**
   * Saves, shows the saved reach at once, and re-reads everything it can
   * change in the background: the save is done when the server accepted it,
   * not when every account list and usage check has been read again.
   * Throws the failure; an API error keeps its facts for Technical details.
   */
  const save = useCallback(
    async (draft: ModelConnectionAccessPolicy) => {
      // Created before the write: a sign-out meanwhile refuses the late write.
      const write = sharedQueryWriter(client);
      let saved: ModelConnectionAccessPolicy;
      try {
        saved = await client.updateModelConnectionAccess(target, draft);
      } catch (caught) {
        throw caught instanceof Error && caught.message
          ? caught
          : new Error("Couldn't save. Nothing was changed.", { cause: caught });
      }
      if (current) write([...key], { ...current, policy: saved });
      // Evicts unmounted reads at once and re-reads mounted ones meanwhile,
      // keeping their rows on screen, even when the form was left during save.
      void notifyModelConnectionsChanged(client).catch(() => undefined);
      toast.success("Saved");
    },
    [client, target, key, current],
  );
  return {
    data: query.data,
    error: query.error,
    loading: query.loading,
    reload: query.refresh,
    save,
  };
}

export type ConnectionAccess = ReturnType<typeof useConnectionAccess>;

/**
 * Who can see what an account serves, for a viewer the API refused. At
 * organization scope that is its owners and admins; in a workspace, a private
 * account is visible only to the person who connected it.
 */
function accessRefusedText(organization: boolean): string {
  return organization
    ? "Only organization owners and admins can see this."
    : "Only the person who connected this account can see this.";
}

/** A failed save: what to do, then an API error's facts behind Technical details. */
function saveFailure(caught: unknown): ReactNode {
  const facts = apiErrorTechnicalFacts(caught);
  const advice = userErrorTextWithoutReference(caught, "Couldn't save. Nothing was changed.");
  if (facts.length === 0) return advice;
  return (
    <>
      {advice}
      <div className="mt-1">
        <TechnicalDetails facts={facts} />
      </div>
    </>
  );
}

/** Same choices, whatever the key order; a missing `allowedPeople` is none. */
function samePolicy(a: ModelConnectionAccessPolicy, b: ModelConnectionAccessPolicy): boolean {
  const list = (value: readonly string[] | null | undefined) =>
    value == null ? null : JSON.stringify([...value].sort());
  return (
    list(a.allowedModels) === list(b.allowedModels) &&
    list(a.allowedWorkspaces) === list(b.allowedWorkspaces) &&
    a.allowPersonalWorkspaces === b.allowPersonalWorkspaces &&
    list(a.allowedPeople) === list(b.allowedPeople)
  );
}

/** "1 person", "3 people". */
function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/**
 * The short value for the "Available in" row: "All workspaces + Personal",
 * "No workspaces", "3 people". Workspaces that use the account as their own
 * (`localWorkspaceIds`) always count.
 */
export function workspacesShort(
  policy: ModelConnectionAccessPolicy,
  personalSupported: boolean,
  localWorkspaceIds: readonly string[] = [],
): string {
  if (policy.allowedPeople) {
    return policy.allowedPeople.length === 0 ? "No one" : peopleCount(policy.allowedPeople.length);
  }
  return workspaceReachSummary(
    {
      workspaceIds: policy.allowedWorkspaces,
      personalWorkspaces: policy.allowPersonalWorkspaces,
    },
    {
      owner: "organization",
      personalWorkspaces: personalSupported ? "choice" : "none",
      alwaysIncluded: localWorkspaceIds,
    },
  );
}

/** The short value for the "Models it can serve" row. */
export function modelsShort(policy: ModelConnectionAccessPolicy): string {
  if (policy.allowedModels === null) return "All models";
  const count = policy.allowedModels.length;
  return count === 0 ? "No models" : count === 1 ? "1 model" : `${count} models`;
}

/**
 * The short value for "Available in" on a workspace's own account, at that
 * workspace: "Only this workspace", "This workspace + 2 more".
 */
export function servedShort(
  policy: ModelConnectionAccessPolicy,
  localWorkspaceIds: readonly string[] = [],
): string {
  const others = (policy.allowedWorkspaces ?? []).filter(
    (id) => !localWorkspaceIds.includes(id),
  ).length;
  return others === 0 ? "Only this workspace" : `This workspace + ${others} more`;
}

/**
 * "Models it can serve" on an account's page, including unrestricted accounts.
 * At organization scope it also shows the workspaces that can use it.
 */
export function ConnectionAccessRows({
  access,
  organization,
  canManage,
  onEdit,
}: {
  access: ConnectionAccess;
  organization: boolean;
  canManage: boolean;
  onEdit: () => void;
}) {
  if (access.error && isPermissionDenied(access.error)) {
    // A refusal, not a failure: say who can see it, calmly and without Try again.
    return <SettingRow label="Models it can serve" description={accessRefusedText(organization)} />;
  }
  if (access.error) {
    return (
      <SettingRow
        label="Models it can serve"
        description="Couldn't load this."
        control={
          <RowButton variant="ghost" onClick={() => void access.reload()}>
            Try again
          </RowButton>
        }
      />
    );
  }
  const policy = access.data?.policy;
  // A workspace's own subscription account can serve other workspaces too.
  const shares = !organization && Boolean(access.data?.managedByWorkspaceId);
  if (!policy)
    return (
      <>
        {organization ? (
          <SettingRow label="Available in" control={<ModelSettingsPlaceholder />} />
        ) : null}
        <SettingRow
          label="Models it can serve"
          description={
            organization
              ? "New models are included until you limit them."
              : "The workspace's Allowed models still apply."
          }
          control={<ModelSettingsPlaceholder />}
        />
      </>
    );
  return (
    <>
      {organization ? (
        <SettingNavRow
          label="Available in"
          value={workspacesShort(
            policy,
            access.data!.personalWorkspacesSupported,
            access.data!.localWorkspaceIds,
          )}
          disabled={!canManage}
          onOpen={onEdit}
        />
      ) : shares ? (
        <SettingNavRow
          label="Available in"
          value={servedShort(policy, access.data!.localWorkspaceIds)}
          disabled={!canManage}
          onOpen={onEdit}
        />
      ) : null}
      <SettingNavRow
        label="Models it can serve"
        description={
          organization
            ? "New models are included until you limit them."
            : shares
              ? "Each workspace's Allowed models still apply."
              : "The workspace's Allowed models still apply."
        }
        value={modelsShort(policy)}
        // At organization scope both rows open the same page.
        disabled={!canManage}
        onOpen={onEdit}
      />
    </>
  );
}

/** The workspaces that keep an account as their own, by name where listed. */
function localNames(
  local: readonly string[],
  workspaces: readonly { id: string; name: string }[],
): string {
  const names = local.flatMap(
    (id) => workspaces.find((workspace) => workspace.id === id)?.name ?? [],
  );
  if (names.length !== local.length) {
    return local.length === 1
      ? "the workspace that keeps it as its own"
      : "the workspaces that keep it as their own";
  }
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function toggle(values: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

/** A quiet line under a choice that, as drafted, leaves the account serving nothing. */
function EmptyChoiceHint({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 text-sm leading-5 text-fg-muted">
      {children}
    </p>
  );
}

/** The form page: which workspaces (organization) and which models this account serves. */
export function ConnectionAccessFormPage({
  access,
  organization,
  organizationName = "your organization",
  canManage,
  name,
  onClose,
}: {
  access: ConnectionAccess;
  organization: boolean;
  /** The organization that owns it, named in its owner line and choices. */
  organizationName?: string | undefined;
  canManage: boolean;
  /** The account's name, for the title and the back link. */
  name: string;
  onClose: () => void;
}) {
  const { data } = access;
  const [draft, setDraft] = useState<ModelConnectionAccessPolicy | null>(data?.policy ?? null);
  const [error, setError] = useState<ReactNode>(null);
  const keptNoteId = useId();
  const servableHintId = useId();
  useEffect(() => {
    if (data && !draft) setDraft(data.policy);
  }, [data, draft]);
  const dirty = Boolean(draft && data && !samePolicy(draft, data.policy));
  const disabled = !canManage;
  // Workspaces that use the account as their own keep it for any workspace choice.
  const local = data?.localWorkspaceIds ?? [];
  // A workspace's own account (D-52): its workspace's admins share it with
  // workspaces they also administer; the organization's owners and admins
  // share it with any, and move it to the organization to go wider.
  const owner = data?.managedByWorkspaceId ?? null;
  const shares = !organization && owner !== null;
  const ownerName = owner
    ? data?.workspaces.find((workspace) => workspace.id === owner)?.name
    : undefined;
  // People saved earlier stay a choice even when the member list can't be shown.
  const people = Boolean(organization && (data?.peopleSupported || data?.policy.allowedPeople));
  const peopleListed = Boolean(data?.people);
  const scope = draft?.allowedPeople
    ? "people"
    : draft?.allowedWorkspaces === null
      ? "all"
      : "only";
  const reachesNoWorkspace = Boolean(
    organization &&
    draft &&
    data &&
    scope === "only" &&
    draft.allowedWorkspaces!.length === 0 &&
    local.length === 0 &&
    !(data.personalWorkspacesSupported && draft.allowPersonalWorkspaces),
  );
  const reachesNoOne = scope === "people" && draft!.allowedPeople!.length === 0;
  const keptNote = scope === "people" && !reachesNoOne && local.length > 0;
  // Every shared workspace, Personal workspaces or people make a workspace's
  // own account the organization's: said here, and sent as an explicit move.
  const needsMove = Boolean(
    organization &&
    owner &&
    draft &&
    data &&
    (scope !== "only" || (data.personalWorkspacesSupported && draft.allowPersonalWorkspaces)),
  );
  // On a workspace's own route its workspace leads, then the others by name.
  const servable = shares
    ? [...(data?.workspaces ?? [])].sort(
        (a, b) =>
          Number(local.includes(b.id)) - Number(local.includes(a.id)) ||
          a.name.localeCompare(b.name),
      )
    : [];
  /** A workspace choice; `allowedPeople` is cleared only when people were saved. */
  const withoutPeople = (policy: ModelConnectionAccessPolicy): ModelConnectionAccessPolicy => {
    const { allowedPeople: _dropped, ...rest } = policy;
    return data?.policy.allowedPeople ? { ...rest, allowedPeople: null } : rest;
  };

  const body =
    access.error && !data ? (
      isPermissionDenied(access.error) ? (
        <Notice tone="muted" title="You can't see what this account can serve.">
          {accessRefusedText(organization)}
        </Notice>
      ) : (
        <ErrorMessage
          title="Couldn't load what this account can serve."
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => void access.reload()}>
              Try again
            </Button>
          }
          {...apiErrorDetails(access.error)}
        >
          {apiErrorAdvice(access.error)}
        </ErrorMessage>
      )
    ) : draft && data ? (
      <FieldStack>
        {data.personalSharingSupported ? (
          <Notice tone="muted" title="Share your personal account">
            Sharing makes this an organization-managed account. Consumer plans may limit use to the
            account holder.
          </Notice>
        ) : null}
        {organization ? (
          <div className="flex min-w-0 flex-col gap-3">
            <WorkspaceReachFields
              owner={{ kind: "organization", name: organizationName }}
              organizationName={organizationName}
              managedBy="Organization owners and admins manage it."
              label={people ? "Who can use it" : "Available in"}
              value={{
                workspaceIds: draft.allowedPeople ? [] : draft.allowedWorkspaces,
                personalWorkspaces: draft.allowPersonalWorkspaces,
              }}
              onChange={(next) => {
                setError(null);
                // Leaving people restores the saved Personal choice too.
                const allowPersonalWorkspaces =
                  draft.allowedPeople && !data.policy.allowedPeople
                    ? data.policy.allowPersonalWorkspaces
                    : next.personalWorkspaces;
                setDraft(
                  withoutPeople({
                    ...draft,
                    allowPersonalWorkspaces,
                    allowedWorkspaces: next.workspaceIds === null ? null : [...next.workspaceIds],
                  }),
                );
              }}
              workspaces={data.workspaces}
              // Chosen workspaces start from the saved ones: none when people
              // were saved, every shared workspace when all were saved
              // (including one that also keeps it as its own, so narrowing
              // never drops that workspace's organization grant unseen).
              seedSelected={() =>
                data.policy.allowedPeople
                  ? []
                  : (data.policy.allowedWorkspaces ??
                    data.workspaces.map((workspace) => workspace.id))
              }
              alwaysIncluded={Object.fromEntries(
                local.map((id) => [id, "Connected in this workspace, so it's always included."]),
              )}
              personalWorkspaces={data.personalWorkspacesSupported ? "choice" : "none"}
              disabled={disabled}
              extraChoice={
                people
                  ? {
                      value: "people",
                      title: "Only selected people",
                      description: "Only their own chats and automations.",
                      chosen: scope === "people",
                      onChoose: () => {
                        setError(null);
                        setDraft({
                          ...draft,
                          allowedWorkspaces: [],
                          allowPersonalWorkspaces: false,
                          allowedPeople: data.policy.allowedPeople ?? [],
                        });
                      },
                      content: (
                        <>
                          {peopleListed ? (
                            <fieldset
                              className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
                              aria-describedby={keptNote ? keptNoteId : undefined}
                            >
                              <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">
                                People
                              </legend>
                              {[
                                ...(data.people ?? []),
                                // Someone chosen earlier who has since left the organization.
                                ...(draft.allowedPeople ?? [])
                                  .filter((id) => !data.people?.some((person) => person.id === id))
                                  .map((id) => ({ id, name: "Former member", email: null })),
                              ].map((person) => (
                                <CheckboxField
                                  key={person.id}
                                  label={person.name ?? person.email ?? "Unnamed member"}
                                  description={
                                    person.name && person.email ? person.email : undefined
                                  }
                                  disabled={disabled}
                                  checked={(draft.allowedPeople ?? []).includes(person.id)}
                                  onCheckedChange={(checked) =>
                                    setDraft({
                                      ...draft,
                                      allowedPeople: toggle(
                                        draft.allowedPeople ?? [],
                                        person.id,
                                        checked,
                                      ),
                                    })
                                  }
                                />
                              ))}
                            </fieldset>
                          ) : (
                            <p className="m-0 text-sm text-fg-muted">
                              {(draft.allowedPeople ?? []).length > 0
                                ? `${peopleCount((draft.allowedPeople ?? []).length)} chosen. `
                                : ""}
                              This organization has too many members to list here.
                            </p>
                          )}
                          {reachesNoOne ? (
                            <EmptyChoiceHint>
                              No one can use it. It stays connected, ready to share later.
                            </EmptyChoiceHint>
                          ) : null}
                        </>
                      ),
                    }
                  : undefined
              }
            />
            {/* A workspace that keeps it as its own follows the people choice too.
                Where people are offered without a People list to describe and a
                workspace keeps it, it is a status that stays in place (empty and
                hidden until needed), so its line is announced. */}
            {keptNote || (people && !peopleListed && local.length > 0) ? (
              <p
                id={keptNoteId}
                role={peopleListed ? undefined : "status"}
                className={keptNote ? "m-0 text-sm text-fg-muted" : "sr-only"}
              >
                {keptNote
                  ? `In ${localNames(local, data.workspaces)} too, only these people can use it.`
                  : null}
              </p>
            ) : null}
            {reachesNoWorkspace ? (
              <EmptyChoiceHint>
                No workspace can use it. It stays connected, ready to share later.
              </EmptyChoiceHint>
            ) : null}
            {needsMove ? (
              <Notice tone="info" title="This moves it to the organization">
                {`The admins of ${ownerName ?? "the workspace it was connected in"} will no longer manage it. Only the organization's owners and admins will.`}
              </Notice>
            ) : null}
          </div>
        ) : shares ? (
          <fieldset aria-describedby={servableHintId} className="m-0 min-w-0 border-0 p-0">
            {/* Styled like the form's other groups ("Models it can serve"). */}
            <legend className="p-0 text-sm font-medium text-fg">Workspaces that can use it</legend>
            <p id={servableHintId} className="mt-0.5 text-xs leading-4.5 text-fg-muted">
              You can add workspaces you're an admin of.
            </p>
            <div className="mt-2 flex min-w-0 flex-col gap-3">
              {servable.map((workspace) =>
                local.includes(workspace.id) ? (
                  <CheckboxField
                    key={workspace.id}
                    label={workspace.name}
                    disabledReason="Connected in this workspace, so it's always included."
                    disabled
                    checked
                  />
                ) : (
                  <CheckboxField
                    key={workspace.id}
                    label={workspace.name}
                    disabled={disabled}
                    checked={(draft.allowedWorkspaces ?? []).includes(workspace.id)}
                    onCheckedChange={(checked) => {
                      setError(null);
                      setDraft({
                        ...draft,
                        allowedWorkspaces: toggle(
                          draft.allowedWorkspaces ?? [],
                          workspace.id,
                          checked,
                        ),
                      });
                    }}
                  />
                ),
              )}
            </div>
          </fieldset>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3">
          <ChoiceCards
            label="Models it can serve"
            description={
              organization
                ? undefined
                : shares
                  ? "Allowed models for each workspace still apply on top of this."
                  : "Allowed models for the workspace still apply on top of this."
            }
            value={draft.allowedModels === null ? "all" : "only"}
            disabled={disabled}
            onValueChange={(value) => {
              setError(null);
              setDraft({
                ...draft,
                allowedModels: value === "all" ? null : data.models.map((model) => model.id),
              });
            }}
          >
            <ChoiceCard
              value="all"
              title="All models, including new ones"
              description="Includes models the provider adds later."
            />
            <ChoiceCard
              value="only"
              title="Only the models I choose"
              description="New models stay off until you add them here."
            />
          </ChoiceCards>
          {draft.allowedModels !== null ? (
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">Models</legend>
              {[
                ...data.models,
                ...draft.allowedModels
                  .filter((modelId) => !data.models.some((model) => model.id === modelId))
                  .map((modelId) => ({ id: modelId, label: modelId })),
              ].map((model) => (
                <CheckboxField
                  key={model.id}
                  label={model.label}
                  disabled={disabled}
                  checked={draft.allowedModels!.includes(model.id)}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      allowedModels: toggle(draft.allowedModels!, model.id, checked),
                    })
                  }
                />
              ))}
              {data.models.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No models yet. Add a custom model to this connection first.
                </p>
              ) : draft.allowedModels.length === 0 ? (
                <EmptyChoiceHint>It can't serve any model until you choose one.</EmptyChoiceHint>
              ) : null}
            </fieldset>
          ) : null}
        </div>
      </FieldStack>
    ) : null;

  return (
    <ModelsFormPage
      title={organization || shares ? `Where ${name} can be used` : `Models ${name} can serve`}
      description={
        organization || shares
          ? "Changes apply to new work. Running work rechecks access before its next model call."
          : "Only these models can use this account, including pinned chats. Access is rechecked before the next model call."
      }
      backLabel={name}
      onClose={onClose}
      loading={!data && !access.error}
      submitLabel={
        data?.personalSharingSupported ? "Share account" : needsMove ? "Move and save" : "Save"
      }
      pendingLabel="Saving…"
      submitDisabled={
        !canManage || !dirty || Boolean(data?.personalSharingSupported && reachesNoWorkspace)
      }
      disabledReason={
        canManage ? undefined : "Only people who can manage connections can change this."
      }
      error={error}
      onSubmit={async () => {
        if (!draft) return false;
        try {
          await access.save(
            data?.personalSharingSupported
              ? { ...draft, sharePersonal: true }
              : needsMove
                ? { ...draft, moveToOrganization: true }
                : draft,
          );
        } catch (caught) {
          setError(saveFailure(caught));
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      {body}
    </ModelsFormPage>
  );
}
