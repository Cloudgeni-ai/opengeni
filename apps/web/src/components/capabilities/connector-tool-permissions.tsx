import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  ConnectorToolPermission,
  ConnectorToolPermissionsResponse,
  UpdateConnectorToolPermissionsRequest,
} from "@opengeni/contracts";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

const groups = [
  ["read", "Read-only tools"],
  ["write", "Tools that make changes"],
  ["other", "Other tools"],
] as const;

export function PermissionSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: ConnectorToolPermission | "mixed" | "default";
  disabled?: boolean;
  onChange: (value: ConnectorToolPermission) => void;
}) {
  return (
    <select
      aria-label={label}
      name={label}
      value={value}
      disabled={disabled}
      className="h-8 shrink-0 rounded-md border border-border bg-surface px-2 text-xs text-fg disabled:opacity-50"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value as ConnectorToolPermission)}
    >
      {value === "mixed" ? (
        <option value="mixed" disabled>
          Mixed
        </option>
      ) : null}
      {value === "default" ? (
        <option value="default" disabled>
          Existing policy
        </option>
      ) : null}
      <option value="allow">Allow</option>
      <option value="ask">Ask first</option>
      <option value="block">Block</option>
    </select>
  );
}

export function ConnectorToolPermissions({
  workspaceId,
  capabilityId,
}: {
  workspaceId: string;
  capabilityId: string;
}) {
  const { client } = useAppContext();
  const [data, setData] = useState<ConnectorToolPermissionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/tool-permissions`;
  const scope = useRef({ path, epoch: 0 });
  const mutationController = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    scope.current = { path, epoch: scope.current.epoch + 1 };
    setBusy(false);
    setSaved(false);
    setData(null);
    setError(null);
    return () => {
      scope.current.epoch += 1;
      mutationController.current?.abort();
      mutationController.current = null;
    };
  }, [path, client]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void client
      .getConnectorToolPermissions(workspaceId, capabilityId, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Could not load tool permissions.");
      });
    return () => controller.abort();
  }, [path, generation, client, workspaceId, capabilityId]);
  async function update(
    selection: { target: "default" } | { target: "tools"; toolNames: string[] },
    permission: ConnectorToolPermission,
  ) {
    if (!data || busy || mutationController.current) return;
    const currentScope = { ...scope.current };
    if (currentScope.path !== path) return;
    const isCurrent = () =>
      scope.current.path === currentScope.path && scope.current.epoch === currentScope.epoch;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await client.updateConnectorToolPermissions(
        workspaceId,
        capabilityId,
        {
          connectionId: data.connectionId,
          ...selection,
          permission,
        } satisfies UpdateConnectorToolPermissionsRequest,
        { signal: controller.signal },
      );
      if (!isCurrent()) return;
      setData((current) =>
        current
          ? {
              ...current,
              ...(selection.target === "default" ? { defaultPermission: permission } : {}),
              tools: current.tools.map((tool) =>
                (selection.target === "tools" && selection.toolNames.includes(tool.name)) ||
                (selection.target === "default" && tool.inherited)
                  ? { ...tool, permission, inherited: selection.target === "default" }
                  : tool,
              ),
            }
          : current,
      );
      setSaved(true);
    } catch (failure) {
      // Aborting only discards this view's response. A write may have committed;
      // the next mount always reloads the authoritative saved permissions.
      if (isCurrent() && !controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Could not save tool permissions.");
    } finally {
      if (isCurrent()) {
        setBusy(false);
        mutationController.current = null;
      }
    }
  }
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-label="Tool permissions">
      <div>
        <h3 className="text-sm font-medium">Tool permissions</h3>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">
          Choose when OpenGeni can use this connector. Changes apply from the next turn. Existing
          approvals remain in place.
        </p>
      </div>
      {error ? <Notice tone="failed">{error}</Notice> : null}
      {!data && !error ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading tools…
        </p>
      ) : null}
      {data ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Default for new tools</span>
            <PermissionSelect
              label="Default tool permission"
              value={data.defaultPermission ?? "default"}
              disabled={busy || !data.canManage}
              onChange={(value) => void update({ target: "default" }, value)}
            />
          </div>
          <p className="text-xs text-fg-subtle">
            Individual choices override this default. Allow keeps any approval required by your
            workspace or session. Action-specific rules still apply.
          </p>
          {data.discoveryError ? <Notice tone="waiting">{data.discoveryError}</Notice> : null}
          {groups.map(([key, title]) => {
            const tools = data.tools.filter((tool) => tool.group === key);
            if (!tools.length) return null;
            const first = tools[0]!.permission;
            const groupValue = tools.every((tool) => tool.permission === first) ? first : "mixed";
            return (
              <details
                key={key}
                open={key === "read"}
                className="group border-t border-border pt-3"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
                  <span className="flex items-center gap-2">
                    <ChevronRightIcon
                      aria-hidden
                      className="size-3.5 text-fg-subtle transition-transform group-open:rotate-90"
                    />
                    {title} <span className="text-fg-subtle">{tools.length}</span>
                  </span>
                  <PermissionSelect
                    label={`${title} permission`}
                    value={groupValue}
                    disabled={busy || !data.canManage}
                    onChange={(value) =>
                      void update(
                        { target: "tools", toolNames: tools.map((tool) => tool.name) },
                        value,
                      )
                    }
                  />
                </summary>
                <div className="divide-y divide-border">
                  {tools.map((tool) => (
                    <div key={tool.name} className="flex items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <div className="break-words text-sm" title={tool.description}>
                          {tool.title ?? tool.name.replaceAll("_", " ")}
                        </div>
                        {tool.approvalRequired ? (
                          <p className="mt-1 text-xs text-fg-subtle">
                            Approval required by configuration
                          </p>
                        ) : null}
                      </div>
                      <PermissionSelect
                        label={`Permission for ${tool.title ?? tool.name}`}
                        value={tool.permission}
                        disabled={busy || !data.canManage}
                        onChange={(value) =>
                          void update({ target: "tools", toolNames: [tool.name] }, value)
                        }
                      />
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
          {!data.discoveryError && data.tools.length === 0 ? (
            <p className="text-xs text-fg-subtle">This connector currently exposes no tools.</p>
          ) : null}
          <p className="text-xs text-fg-subtle">
            Tool groups use the connector's descriptions of its tools. They do not grant
            permissions.
          </p>
          {saved ? (
            <p role="status" className="text-xs text-fg-subtle">
              Permissions saved.
            </p>
          ) : null}
        </>
      ) : null}
      {error || data?.discoveryError ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setGeneration((value) => value + 1)}
        >
          Retry loading tools
        </Button>
      ) : null}
    </section>
  );
}
