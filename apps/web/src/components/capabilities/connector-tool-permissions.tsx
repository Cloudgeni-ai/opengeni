import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  ConnectorToolPermission,
  ConnectorToolPermissionsResponse,
  UpdateConnectorToolPermissionsRequest,
} from "@opengeni/contracts";
import { useAppContext } from "@/context";
import { isPermissionDenied, userErrorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SelectMenu } from "@/components/ui/select-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

const groups = [
  ["read", "Read-only tools"],
  ["write", "Tools that make changes"],
  ["other", "Other tools"],
] as const;

/** A workspace-enabled connector need not have an account for this viewer. */
export function hasConnectorToolPermissionTarget(
  item: CapabilityCatalogItem,
  health: ConnectionHealth,
): boolean {
  if (
    !item.enabled ||
    item.kind !== "mcp" ||
    item.source === "built_in" ||
    item.surfaceType === "codex_apps" ||
    item.connectionRef?.authoritySource === "host"
  )
    return false;
  if (item.connectionRef || item.authKind === "oauth2" || item.authKind === "api_key") {
    return (
      (health.state === "connected" || health.state === "attention") && health.connection !== null
    );
  }
  return true;
}

export function PermissionSelect({
  label,
  value,
  disabled,
  onChange,
  resetLabel = "Use default",
}: {
  label: string;
  value: ConnectorToolPermission | "mixed" | "default";
  disabled?: boolean;
  onChange: (value: ConnectorToolPermission | null) => void;
  resetLabel?: string;
}) {
  return (
    <SelectMenu
      aria-label={label}
      name={label}
      value={value}
      disabled={disabled}
      size="sm"
      className="w-40 shrink-0"
      align="end"
      onValueChange={(next) => {
        if (next !== "mixed") onChange(next === "default" ? null : next);
      }}
      options={[
        ...(value === "mixed" ? [{ value: "mixed" as const, label: "Mixed", disabled: true }] : []),
        { value: "allow", label: "Allow", description: "Run without asking." },
        { value: "ask", label: "Ask first", description: "Review each action before it runs." },
        { value: "block", label: "Block", description: "Do not run this action." },
        { value: "default", label: resetLabel },
      ]}
    />
  );
}

export function ConnectorToolPermissions({
  workspaceId,
  capabilityId,
  bare = false,
}: {
  workspaceId: string;
  capabilityId: string;
  /** Inside a page section that already names it: drop the frame and heading. */
  bare?: boolean;
}) {
  const { client } = useAppContext();
  const [data, setData] = useState<ConnectorToolPermissionsResponse | null>(null);
  // `denied`: the viewer may not see these permissions. Say who can help, no Retry.
  const [error, setError] = useState<{ text: string; denied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const basePath = `${workspaceId}:${capabilityId}`;
  const [account, setAccount] = useState<{
    path: string;
    connectionId: string;
    instanceKey?: string;
  } | null>(null);
  const selectedAccount = account?.path === basePath ? account : null;
  const path = `${basePath}:${selectedAccount?.connectionId ?? ""}:${selectedAccount?.instanceKey ?? ""}`;
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
      .getConnectorToolPermissions(workspaceId, capabilityId, {
        signal: controller.signal,
        ...(selectedAccount
          ? { connectionId: selectedAccount.connectionId, instanceKey: selectedAccount.instanceKey }
          : {}),
      })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError(
          isPermissionDenied(failure)
            ? {
                text: "You can't see this connector's tool permissions. Ask a workspace admin for access.",
                denied: true,
              }
            : { text: `Couldn't load tool permissions. ${userErrorText(failure)}`, denied: false },
        );
      });
    return () => controller.abort();
  }, [path, generation, client, workspaceId, capabilityId, selectedAccount]);
  async function update(
    selection:
      | { target: "default" }
      | { target: "tools"; toolNames: string[] }
      | { target: "action"; toolName: string; actionName: string },
    permission: ConnectorToolPermission | null,
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
          ...(data.revision ? { expectedRevision: data.revision } : {}),
          ...(data.instanceKey ? { instanceKey: data.instanceKey } : {}),
          ...selection,
          permission,
        } satisfies UpdateConnectorToolPermissionsRequest,
        { signal: controller.signal },
      );
      if (!isCurrent()) return;
      const refreshed = await client.getConnectorToolPermissions(workspaceId, capabilityId, {
        signal: controller.signal,
        connectionId: data.connectionId,
        ...(data.instanceKey ? { instanceKey: data.instanceKey } : {}),
      });
      if (!isCurrent()) return;
      setData(refreshed);
      setSaved(true);
    } catch (failure) {
      // Aborting only discards this view's response. A write may have committed;
      // the next mount always reloads the authoritative saved permissions.
      if (isCurrent() && !controller.signal.aborted)
        setError({
          text: `Couldn't save tool permissions. ${userErrorText(failure)}`,
          denied: false,
        });
    } finally {
      if (isCurrent()) {
        setBusy(false);
        mutationController.current = null;
      }
    }
  }
  return (
    <section
      className={bare ? "space-y-3" : "space-y-3 border-t border-border pt-5"}
      aria-label="Tool permissions"
    >
      {bare ? null : (
        <div>
          <h3 className="text-sm font-medium">Tool permissions</h3>
          <p className="mt-1 text-xs leading-5 text-fg-subtle">
            Choose which actions run automatically and which need your review.
          </p>
        </div>
      )}
      {error ? <Notice tone={error.denied ? "muted" : "failed"}>{error.text}</Notice> : null}
      {!data && !error ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading tools…
        </p>
      ) : null}
      {data ? (
        <>
          {(data.accounts?.length ?? 0) > 1 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg">Account</p>
              <SelectMenu
                aria-label="Account for tool permissions"
                className="w-full"
                size="sm"
                value={JSON.stringify([data.connectionId, data.instanceKey ?? ""])}
                disabled={busy}
                options={data.accounts!.map((item) => ({
                  value: JSON.stringify([item.connectionId, item.instanceKey ?? ""]),
                  label: item.label,
                }))}
                onValueChange={(value) => {
                  const chosen = data.accounts!.find(
                    (item) => JSON.stringify([item.connectionId, item.instanceKey ?? ""]) === value,
                  );
                  if (chosen)
                    setAccount({
                      path: basePath,
                      connectionId: chosen.connectionId,
                      ...(chosen.instanceKey ? { instanceKey: chosen.instanceKey } : {}),
                    });
                }}
              />
            </div>
          ) : data.accountLabel ? (
            <p className="break-words text-sm text-fg-muted">{data.accountLabel}</p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg">Default choice</span>
            <PermissionSelect
              label="Default tool permission"
              value={data.defaultPermission ?? "default"}
              resetLabel="Recommended"
              disabled={busy || !data.canManage}
              onChange={(value) => void update({ target: "default" }, value)}
            />
          </div>
          <p className="text-xs text-fg-subtle">
            Applies to tools without an individual choice, including newly added tools.
          </p>
          {data.tools.some((tool) => tool.resetReason) ? (
            <Notice tone="waiting">
              Some actions changed since you allowed them. Those actions now ask first; review their
              choices below.
            </Notice>
          ) : null}
          {data.discoveryError ? <Notice tone="waiting">{data.discoveryError}</Notice> : null}
          {groups.map(([key, title]) => {
            const tools = data.tools.filter((tool) => tool.group === key);
            if (!tools.length) return null;
            const first = tools[0]!.permission;
            const groupValue = tools.every((tool) => tool.permission === first && !tool.conditional)
              ? first
              : "mixed";
            return (
              <Collapsible
                key={key}
                className="group border-t border-border pt-3"
                open={expandedGroups.includes(key)}
                onOpenChange={(open) =>
                  setExpandedGroups((current) =>
                    open ? [...current, key] : current.filter((value) => value !== key),
                  )
                }
              >
                <div className="flex items-center justify-between gap-3">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-0 flex-1 shrink justify-start px-0 text-fg"
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-fg-muted transition-transform group-data-[state=open]:rotate-90"
                      />
                      <span className="text-left whitespace-normal">{title}</span>{" "}
                      <span className="text-fg-muted">{tools.length}</span>
                    </Button>
                  </CollapsibleTrigger>
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
                </div>
                <CollapsibleContent className="divide-y divide-border">
                  {tools.map((tool) => (
                    <div key={tool.name} className="space-y-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="break-words text-sm" title={tool.description}>
                            {tool.title ?? tool.name.replaceAll("_", " ")}
                          </div>
                          <p className="mt-1 text-xs text-fg-muted">
                            {tool.resetReason
                              ? "Action changed · reset to Ask first"
                              : tool.conditional
                                ? "Different choices for individual actions"
                                : tool.source === "recommended"
                                  ? "Recommended"
                                  : tool.inherited
                                    ? "Uses default choice"
                                    : "Your choice"}
                          </p>
                        </div>
                        <PermissionSelect
                          label={`Permission for ${tool.title ?? tool.name}`}
                          value={tool.conditional ? "mixed" : tool.permission}
                          disabled={busy || !data.canManage}
                          onChange={(value) =>
                            void update({ target: "tools", toolNames: [tool.name] }, value)
                          }
                        />
                      </div>
                      {tool.actionPermissions?.map((action) => (
                        <div
                          key={action.actionName}
                          className="flex items-center justify-between gap-3 pl-4"
                        >
                          <span className="min-w-0 break-words text-sm text-fg">
                            {action.actionName.replaceAll("_", " ")}
                          </span>
                          <PermissionSelect
                            label={`Permission for ${tool.title ?? tool.name}: ${action.actionName}`}
                            value={action.permission}
                            disabled={busy || !data.canManage}
                            onChange={(permission) =>
                              void update(
                                {
                                  target: "action",
                                  toolName: tool.name,
                                  actionName: action.actionName,
                                },
                                permission,
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {!data.discoveryError && data.tools.length === 0 ? (
            <p className="text-xs text-fg-subtle">This connector currently exposes no tools.</p>
          ) : null}
          <p className="text-xs text-fg-subtle">
            Saved choices apply when work next starts or resumes. A review already waiting for you
            keeps its original choice.
          </p>
          {!data.canManage ? (
            <p className="text-xs text-fg-muted">
              You can view these choices. A workspace admin can change them.
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-xs text-fg-muted">
              Saving choices…
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-xs text-fg-subtle">
              Permissions saved.
            </p>
          ) : null}
        </>
      ) : null}
      {(error && !error.denied) || data?.discoveryError ? (
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
