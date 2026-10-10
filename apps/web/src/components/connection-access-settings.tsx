import type { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@/components/models/models-ui";
import { RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { ErrorMessage, TechnicalDetails } from "@/components/ui/error-message";
import { CheckboxField, FieldStack } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SettingNavRow, SettingRow } from "@/components/ui/setting-row";
import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorTechnicalFacts,
  isPermissionDenied,
  userErrorTextWithoutReference,
} from "@/lib/api-error";

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
  const [data, setData] = useState<ModelConnectionAccessResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const target = useMemo(
    () => ({
      scope: props.organizationId ? ("organizations" as const) : ("workspaces" as const),
      scopeId: props.organizationId ?? props.workspaceId!,
      kind: props.kind,
      connectionId: props.connectionId,
    }),
    [props.organizationId, props.workspaceId, props.kind, props.connectionId],
  );
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await client.getModelConnectionAccess(target);
      if (generation.current !== current) return;
      setData(result);
    } catch (caught) {
      if (generation.current === current)
        setError(
          caught instanceof Error
            ? caught
            : new Error("Couldn't load what this account can serve", { cause: caught }),
        );
    }
  }, [target, client]);
  const enabled = props.enabled ?? true;
  // A newer read, or leaving, makes any read still in flight stale.
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    setData(null);
    if (enabled) void load();
    return invalidate;
  }, [load, enabled, invalidate]);
  /** Saves and re-reads. Throws the failure; an API error keeps its facts for Technical details. */
  const save = useCallback(
    async (draft: ModelConnectionAccessPolicy) => {
      const current = generation.current;
      try {
        await client.updateModelConnectionAccess(target, draft);
      } catch (caught) {
        throw caught instanceof Error && caught.message
          ? caught
          : new Error("Couldn't save. Nothing was changed.", { cause: caught });
      }
      if (generation.current !== current) return;
      await load();
      window.dispatchEvent(new Event("model-connections-changed"));
      toast.success("Saved");
    },
    [client, load, target],
  );
  return { data, error, loading: enabled && !data && !error, reload: load, save };
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
  const personal = personalSupported && policy.allowPersonalWorkspaces;
  const count =
    policy.allowedWorkspaces === null
      ? null
      : new Set([...policy.allowedWorkspaces, ...localWorkspaceIds]).size;
  if (count === 0) return personal ? "Personal workspaces only" : "No workspaces";
  const shared =
    count === null ? "All workspaces" : count === 1 ? "1 workspace" : `${count} workspaces`;
  return personal ? `${shared} + Personal` : shared;
}

/** The short value for the "Models it can serve" row. */
export function modelsShort(policy: ModelConnectionAccessPolicy): string {
  if (policy.allowedModels === null) return "All models";
  const count = policy.allowedModels.length;
  return count === 0 ? "No models" : count === 1 ? "1 model" : `${count} models`;
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
  if (!policy) return null;
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
      ) : null}
      <SettingNavRow
        label="Models it can serve"
        description={
          organization
            ? "New models are included until you limit them."
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
  canManage,
  name,
  onClose,
}: {
  access: ConnectionAccess;
  organization: boolean;
  canManage: boolean;
  /** The account's name, for the title and the back link. */
  name: string;
  onClose: () => void;
}) {
  const { data } = access;
  const [draft, setDraft] = useState<ModelConnectionAccessPolicy | null>(data?.policy ?? null);
  const [error, setError] = useState<ReactNode>(null);
  useEffect(() => {
    if (data && !draft) setDraft(data.policy);
  }, [data, draft]);
  const dirty = Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data.policy));
  const disabled = !canManage;
  // Workspaces that use the account as their own keep it for any workspace choice.
  const local = data?.localWorkspaceIds ?? [];
  const people = Boolean(organization && data?.peopleSupported);
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
        {organization ? (
          <div className="flex min-w-0 flex-col gap-3">
            <ChoiceCards
              label={people ? "Who can use it" : "Which workspaces can use it"}
              value={scope}
              disabled={disabled}
              onValueChange={(value) => {
                setError(null);
                if (value === "people") {
                  setDraft({
                    ...draft,
                    allowedWorkspaces: [],
                    allowPersonalWorkspaces: false,
                    allowedPeople: data.policy.allowedPeople ?? [],
                  });
                  return;
                }
                setDraft(
                  withoutPeople({
                    ...draft,
                    allowedWorkspaces:
                      value === "all"
                        ? null
                        : data.workspaces
                            .map((workspace) => workspace.id)
                            .filter((id) => !local.includes(id)),
                  }),
                );
              }}
            >
              <ChoiceCard
                value="all"
                title="All shared workspaces, including new ones"
                description="Members still need access to the workspace."
              />
              <ChoiceCard
                value="only"
                title="Only selected workspaces"
                description="Other workspaces can't use it for new work."
              />
              {people ? (
                <ChoiceCard
                  value="people"
                  title="Only selected people"
                  description="Only their own chats and schedules, in any workspace."
                />
              ) : null}
            </ChoiceCards>
            {scope === "only" ? (
              <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
                <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">
                  Shared workspaces
                </legend>
                {data.workspaces.map((workspace) =>
                  local.includes(workspace.id) ? (
                    <CheckboxField
                      key={workspace.id}
                      label={workspace.name}
                      description="Connected here, so always included."
                      disabled
                      checked
                    />
                  ) : (
                    <CheckboxField
                      key={workspace.id}
                      label={workspace.name}
                      disabled={disabled}
                      checked={draft.allowedWorkspaces!.includes(workspace.id)}
                      onCheckedChange={(checked) =>
                        setDraft({
                          ...draft,
                          allowedWorkspaces: toggle(
                            draft.allowedWorkspaces!,
                            workspace.id,
                            checked,
                          ),
                        })
                      }
                    />
                  ),
                )}
                {data.workspaces.length === 0 ? (
                  <p className="m-0 text-sm text-fg-muted">
                    This organization has no shared workspaces yet.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {scope === "people" ? (
              <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
                <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">People</legend>
                {[
                  ...(data.people ?? []),
                  // Someone chosen earlier who has since left the organization.
                  ...draft
                    .allowedPeople!.filter((id) => !data.people?.some((person) => person.id === id))
                    .map((id) => ({ id, name: "Former member", email: null })),
                ].map((person) => (
                  <CheckboxField
                    key={person.id}
                    label={person.name ?? person.email ?? "Unnamed member"}
                    description={person.name && person.email ? person.email : undefined}
                    disabled={disabled}
                    checked={draft.allowedPeople!.includes(person.id)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        allowedPeople: toggle(draft.allowedPeople!, person.id, checked),
                      })
                    }
                  />
                ))}
              </fieldset>
            ) : null}
            {reachesNoOne ? (
              <EmptyChoiceHint>
                No one can use it. It stays connected, ready to share later.
              </EmptyChoiceHint>
            ) : null}
            {/* Personal workspaces are their own choice, not one of the shared workspaces above. */}
            {scope === "people" ? null : (
              <div className="mt-2 border-t border-border pt-4">
                {data.personalWorkspacesSupported ? (
                  <CheckboxField
                    label="Personal workspaces"
                    description="Each member's own private workspace."
                    disabled={disabled}
                    checked={draft.allowPersonalWorkspaces}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, allowPersonalWorkspaces: checked })
                    }
                  />
                ) : (
                  <CheckboxField
                    label="Personal workspaces"
                    description="Organization API keys can't be used in Personal workspaces."
                    disabled
                    checked={false}
                  />
                )}
              </div>
            )}
            {reachesNoWorkspace ? (
              <EmptyChoiceHint>
                No workspace can use it. It stays connected, ready to share later.
              </EmptyChoiceHint>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3">
          <ChoiceCards
            label="Models it can serve"
            description={
              organization
                ? undefined
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
      title={organization ? `Where ${name} can be used` : `Models ${name} can serve`}
      description={
        organization
          ? "Changes apply to new chats and schedules. Work already running keeps going."
          : "New work, including chats pinned to this account, can only use these models. Work already running keeps going."
      }
      backLabel={name}
      onClose={onClose}
      loading={!data && !access.error}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!canManage || !dirty}
      disabledReason={
        canManage ? undefined : "Only people who can manage connections can change this."
      }
      error={error}
      onSubmit={async () => {
        if (!draft) return false;
        try {
          await access.save(draft);
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
