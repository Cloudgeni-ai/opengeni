import type { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelsFormPage, RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, FieldStack } from "@/components/ui/field";
import { SettingNavRow, SettingRow } from "@/components/ui/setting-row";

/* ----------------------------------------------------------------------------
   What one model connection can serve: its models, and at organization scope
   the workspaces that may use it. A summary row on the account's page opens a
   form page to change it.
   -------------------------------------------------------------------------- */

export type ConnectionAccessKind = "codex" | "supergrok" | "vercel_gateway" | "openrouter";

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
  const [error, setError] = useState<string | null>(null);
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
          caught instanceof Error ? caught.message : "Couldn't load what this account can serve",
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
  /** Saves and re-reads. Throws with a user-facing message. */
  const save = useCallback(
    async (draft: ModelConnectionAccessPolicy) => {
      const current = generation.current;
      try {
        await client.updateModelConnectionAccess(target, draft);
      } catch (caught) {
        throw new Error(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't save. Nothing was changed.",
          { cause: caught },
        );
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

export function modelsSummary(policy: ModelConnectionAccessPolicy): string {
  if (policy.allowedModels === null) return "All models, including new ones";
  const count = policy.allowedModels.length;
  return count === 0 ? "No models" : count === 1 ? "1 model" : `${count} models`;
}

export function workspacesSummary(
  policy: ModelConnectionAccessPolicy,
  personalSupported: boolean,
): string {
  const shared =
    policy.allowedWorkspaces === null
      ? "All shared workspaces"
      : policy.allowedWorkspaces.length === 1
        ? "1 shared workspace"
        : `${policy.allowedWorkspaces.length} shared workspaces`;
  return personalSupported && policy.allowPersonalWorkspaces ? `${shared} + Personal` : shared;
}

/** The short value for the "Available in" row: "All workspaces + Personal". */
function workspacesShort(policy: ModelConnectionAccessPolicy, personalSupported: boolean): string {
  const shared =
    policy.allowedWorkspaces === null
      ? "All workspaces"
      : policy.allowedWorkspaces.length === 1
        ? "1 workspace"
        : `${policy.allowedWorkspaces.length} workspaces`;
  return personalSupported && policy.allowPersonalWorkspaces ? `${shared} + Personal` : shared;
}

/**
 * "Models it can serve" on an account's page. In a workspace it only shows
 * once the account is limited (the workspace's Allowed models covers the rest);
 * at organization scope it always shows, with the workspaces that can use it.
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
  if (!organization && policy.allowedModels === null) return null;
  const models =
    policy.allowedModels === null
      ? "All models"
      : policy.allowedModels.length === 1
        ? "1 model"
        : `${policy.allowedModels.length} models`;
  return (
    <>
      {organization ? (
        <SettingNavRow
          label="Available in"
          description="The shared workspaces that can use this account."
          value={workspacesShort(policy, access.data!.personalWorkspacesSupported)}
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
        value={models}
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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data && !draft) setDraft(data.policy);
  }, [data, draft]);
  const dirty = Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data.policy));
  const disabled = !canManage;

  const body =
    access.error && !data ? (
      <ErrorMessage
        title="Couldn't load what this account can serve."
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void access.reload()}>
            Try again
          </Button>
        }
      >
        Nothing was changed.
      </ErrorMessage>
    ) : draft && data ? (
      <FieldStack>
        {organization ? (
          <div className="flex min-w-0 flex-col gap-3">
            <ChoiceCards
              label="Which workspaces can use it"
              value={draft.allowedWorkspaces === null ? "all" : "only"}
              disabled={disabled}
              onValueChange={(value) => {
                setError(null);
                setDraft({
                  ...draft,
                  allowedWorkspaces:
                    value === "all" ? null : data.workspaces.map((workspace) => workspace.id),
                });
              }}
            >
              <ChoiceCard
                value="all"
                title="All shared workspaces, including new ones"
                description="Members still need access to the workspace."
              />
              <ChoiceCard
                value="only"
                title="Only the workspaces I choose"
                description="Other workspaces can't use it for new work."
              />
            </ChoiceCards>
            {draft.allowedWorkspaces !== null ? (
              <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
                <legend className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">
                  Shared workspaces
                </legend>
                {data.workspaces.map((workspace) => (
                  <CheckboxField
                    key={workspace.id}
                    label={workspace.name}
                    disabled={disabled}
                    checked={draft.allowedWorkspaces!.includes(workspace.id)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        allowedWorkspaces: toggle(draft.allowedWorkspaces!, workspace.id, checked),
                      })
                    }
                  />
                ))}
              </fieldset>
            ) : null}
            {data.personalWorkspacesSupported ? (
              <CheckboxField
                label="Personal workspaces"
                description="Everyone's private Personal workspace can use it too."
                disabled={disabled}
                checked={draft.allowPersonalWorkspaces}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, allowPersonalWorkspaces: checked })
                }
              />
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
              <legend className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">
                Models
              </legend>
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
          ? "Only these workspaces can use it for new work, and only for these models. Work already running keeps going."
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
          setError(caught instanceof Error ? caught.message : "Couldn't save.");
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      {body}
    </ModelsFormPage>
  );
}
