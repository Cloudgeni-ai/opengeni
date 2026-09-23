import type { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormDisclosure } from "@/components/ui/form-disclosure";

export function ConnectionAccessSettings(props: {
  client: OpenGeniBrowserClient;
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
  kind: "codex" | "supergrok" | "vercel_gateway" | "openrouter";
  connectionId: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelConnectionAccessResponse | null>(null);
  const [draft, setDraft] = useState<ModelConnectionAccessPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const id = useId();
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
      const result = await props.client.getModelConnectionAccess(target);
      if (generation.current !== current) return;
      setData(result);
      setDraft(result.policy);
    } catch (caught) {
      if (generation.current === current)
        setError(caught instanceof Error ? caught.message : "Couldn't load connection access");
    }
  }, [target, props.client]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    if (open) void load();
    return invalidate;
  }, [invalidate, load, open]);
  useEffect(() => {
    setData(null);
    setDraft(null);
  }, [target]);
  const disabled = busy || !props.canManage;
  const dirty = draft && data && JSON.stringify(draft) !== JSON.stringify(data.policy);
  const toggle = (values: string[], value: string, checked: boolean) =>
    checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
  async function save() {
    if (!draft || !props.canManage) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await props.client.updateModelConnectionAccess(target, draft);
      if (generation.current !== current) return;
      await load();
      window.dispatchEvent(new Event("model-connections-changed"));
      toast.success("Connection access updated");
    } catch (caught) {
      if (generation.current === current)
        setError(caught instanceof Error ? caught.message : "Couldn't save connection access");
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormDisclosure
      title={props.organizationId ? "Workspace and model access" : "Model access"}
      summary={
        data
          ? `${data.policy.allowedModels === null ? "All supported models" : `${data.policy.allowedModels.length} models enabled`}${props.organizationId ? ` · ${data.policy.allowedWorkspaces === null ? "All shared workspaces" : `${data.policy.allowedWorkspaces.length} shared workspaces`}` : ""}`
          : "Choose what this connection can be used for"
      }
      open={open}
      onOpenChange={setOpen}
    >
      {error ? (
        <div role="alert" className="grid gap-2 text-xs text-status-waiting">
          <p>{error}</p>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Reload access
          </Button>
        </div>
      ) : null}
      {!draft || !data ? (
        <p className="text-xs text-fg-subtle">Loading access settings…</p>
      ) : (
        <>
          {props.organizationId ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-xs font-medium">
                Workspaces that can use this connection
              </legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  disabled={disabled}
                  checked={draft.allowedWorkspaces === null}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      allowedWorkspaces: event.target.checked
                        ? null
                        : data.workspaces.map((workspace) => workspace.id),
                    })
                  }
                />
                All shared workspaces, including new ones
              </label>
              {draft.allowedWorkspaces !== null
                ? data.workspaces.map((workspace) => (
                    <label key={workspace.id} className="flex items-center gap-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand"
                        disabled={disabled}
                        checked={draft.allowedWorkspaces!.includes(workspace.id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            allowedWorkspaces: toggle(
                              draft.allowedWorkspaces!,
                              workspace.id,
                              event.target.checked,
                            ),
                          })
                        }
                      />
                      {workspace.name}
                    </label>
                  ))
                : null}
              {data.personalWorkspacesSupported ? (
                <label className="flex items-center gap-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand"
                    disabled={disabled}
                    checked={draft.allowPersonalWorkspaces}
                    onChange={(event) =>
                      setDraft({ ...draft, allowPersonalWorkspaces: event.target.checked })
                    }
                  />
                  Personal workspaces
                </label>
              ) : null}
              <p className="text-xs text-fg-subtle">
                Only assigned workspaces can use this connection. Members still need access to the
                workspace.
              </p>
            </fieldset>
          ) : null}
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-xs font-medium">Models enabled for this connection</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                disabled={disabled}
                checked={draft.allowedModels === null}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    allowedModels: event.target.checked
                      ? null
                      : data.models.map((model) => model.id),
                  })
                }
              />
              All supported models, including new ones
            </label>
            {draft.allowedModels !== null ? (
              <div className="grid gap-1">
                {[
                  ...data.models,
                  ...draft.allowedModels
                    .filter((modelId) => !data.models.some((model) => model.id === modelId))
                    .map((modelId) => ({ id: modelId, label: modelId })),
                ].map((model) => (
                  <label key={model.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      disabled={disabled}
                      checked={draft.allowedModels!.includes(model.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          allowedModels: toggle(
                            draft.allowedModels!,
                            model.id,
                            event.target.checked,
                          ),
                        })
                      }
                    />
                    {model.label}
                  </label>
                ))}
                {data.models.length === 0 ? (
                  <p className="text-xs text-fg-subtle">
                    No models configured. Add models to this connection first.
                  </p>
                ) : null}
              </div>
            ) : null}
            <p id={`${id}-help`} className="text-xs text-fg-subtle">
              Applies to new turns, including pinned subscriptions and account rotation. Workspace
              restrictions also apply.
            </p>
          </fieldset>
          {props.canManage ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!dirty || busy}
                aria-describedby={`${id}-help`}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save access"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </FormDisclosure>
  );
}
