import {
  resolveWorkspaceSessionToolDefaults,
  type FirstPartyMcpToolName,
  type WorkspaceSessionToolDefaults,
} from "@opengeni/contracts";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { builtInMcpCapability, sessionCapabilityGroupsFor } from "@/lib/session-capabilities";
import {
  clientFirstPartyMcpToolPolicy,
  firstPartySessionToolOptionsFor,
  type McpServerOption,
} from "@/lib/session-tools";

type Defaults = Required<
  Pick<WorkspaceSessionToolDefaults, "mcpServerIds" | "firstPartyMcpTools">
> &
  Pick<WorkspaceSessionToolDefaults, "inheritConnectedMcpServers">;
type SelectionPatch = {
  firstPartyMcpTools?: FirstPartyMcpToolName[] | null;
  mcpServerIds?: string[] | null;
  inheritConnectedMcpServers?: boolean | null;
};

export function WorkspaceCapabilityDefaults({
  workspaceId,
  canManage,
  kind,
}: {
  workspaceId: string;
  canManage: boolean;
  kind: "permissions" | "plugins";
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const policy = clientFirstPartyMcpToolPolicy(context.clientConfig);
  const configured = resolveWorkspaceSessionToolDefaults(workspace?.settings);
  const defaults: Defaults = {
    ...(configured?.mcpServerIds !== undefined
      ? { inheritConnectedMcpServers: configured.inheritConnectedMcpServers }
      : { inheritConnectedMcpServers: true }),
    mcpServerIds: configured?.mcpServerIds ?? context.toolMcpServers.map((server) => server.id),
    firstPartyMcpTools: configured?.firstPartyMcpTools ?? policy.default,
  };
  const custom =
    kind === "permissions"
      ? configured?.firstPartyMcpTools !== undefined ||
        (configured?.mcpServerIds !== undefined &&
          context.toolMcpServers.some(
            (server) =>
              builtInMcpCapability(server) && !configured.mcpServerIds!.includes(server.id),
          ))
      : configured?.mcpServerIds !== undefined;
  return (
    <WorkspaceCapabilityDefaultsView
      servers={context.toolMcpServers}
      firstPartyTools={firstPartySessionToolOptionsFor(policy.allowed)}
      defaults={defaults}
      custom={custom}
      revisionKey={workspace?.updatedAt ?? workspaceId}
      canManage={canManage}
      kind={kind}
      onSave={async (patch) => {
        const invocation = context.captureWorkspaceInvocation(workspaceId);
        if (!invocation) return false;
        const updated = await context.updateWorkspaceSettings(workspaceId, {
          sessionToolDefaults: patch,
        });
        if (!updated || !context.ownsWorkspaceInvocation(workspaceId, invocation)) return false;
        toast.success("Defaults for new sessions updated");
        return true;
      }}
    />
  );
}

/** Presentations never write until the user explicitly customizes and saves. */
export function WorkspaceCapabilityDefaultsView({
  servers,
  firstPartyTools,
  defaults,
  revisionKey,
  canManage,
  kind,
  custom = false,
  onSave,
}: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  defaults: Defaults;
  revisionKey: string;
  canManage: boolean;
  kind: "permissions" | "plugins";
  custom?: boolean;
  onSave: (patch: SelectionPatch) => Promise<boolean>;
}) {
  const permissions = kind === "permissions";
  const groups = useMemo(
    () => sessionCapabilityGroupsFor(firstPartyTools).filter((group) => group.kind === "opengeni"),
    [firstPartyTools],
  );
  const nativeServers = servers.filter((server) => builtInMcpCapability(server));
  const connectedServers = servers.filter((server) => !builtInMcpCapability(server));
  const source = permissions ? defaults.firstPartyMcpTools : defaults.mcpServerIds;
  const sourceKey = JSON.stringify([
    revisionKey,
    kind,
    custom,
    source,
    defaults.mcpServerIds,
    defaults.inheritConnectedMcpServers,
  ]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(source));
  const [selectedMcp, setSelectedMcp] = useState<Set<string>>(() => new Set(defaults.mcpServerIds));
  const [inheritConnectors, setInheritConnectors] = useState(
    defaults.inheritConnectedMcpServers === true,
  );
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelected(new Set(source));
    setSelectedMcp(new Set(defaults.mcpServerIds));
    setInheritConnectors(defaults.inheritConnectedMcpServers === true);
    setEditing(false);
    setResetting(false);
    setError(null);
    // A stored revision change, not array identity, resets the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  const disabled = !canManage || saving || !editing;
  const toggle = (ids: readonly string[]) =>
    setSelected((current) => {
      const next = new Set(current);
      const enable = !ids.every((id) => current.has(id));
      for (const id of ids) {
        if (enable) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const save = async (reset: boolean) => {
    if (!canManage || saving) return;
    setSaving(true);
    setError(null);
    try {
      const nativeSelectionChanged =
        JSON.stringify([...selectedMcp].sort()) !==
        JSON.stringify([...defaults.mcpServerIds].sort());
      const nativeResetRequired =
        reset && nativeServers.some((server) => !defaults.mcpServerIds.includes(server.id));
      const nextMcpIds = reset
        ? [
            ...new Set([...defaults.mcpServerIds, ...nativeServers.map((server) => server.id)]),
          ].sort()
        : [...selectedMcp].sort();
      const patch: SelectionPatch = permissions
        ? {
            firstPartyMcpTools: reset ? null : ([...selected].sort() as FirstPartyMcpToolName[]),
            ...((!reset && nativeSelectionChanged) || nativeResetRequired
              ? {
                  mcpServerIds: nextMcpIds,
                  ...(defaults.inheritConnectedMcpServers !== undefined
                    ? { inheritConnectedMcpServers: defaults.inheritConnectedMcpServers }
                    : {}),
                }
              : {}),
          }
        : {
            mcpServerIds: reset ? null : [...selected].sort(),
            inheritConnectedMcpServers: reset ? null : inheritConnectors,
          };
      if (await onSave(patch)) {
        setEditing(false);
        setResetting(false);
      } else setError("Could not save. Your selection has been kept; please try again.");
    } catch {
      setError("Could not save. Your selection has been kept; please try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label={permissions ? "Built-in tool defaults" : "Connector defaults"}
      className="grid min-w-0 gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">
            {custom ? "Custom workspace selection" : "Using deployment defaults"}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-fg-muted">
            {custom
              ? "This workspace has custom tool defaults. Deployment restrictions and required approvals still apply."
              : "Tools are available by default. New sessions follow deployment defaults, including future updates."}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Changes apply to new sessions only. Deployment restrictions always apply.
          </p>
        </div>
        {!editing && !resetting ? (
          <div className="flex flex-wrap gap-2">
            {custom ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!canManage || saving}
                onClick={() => setResetting(true)}
              >
                Use deployment defaults
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!canManage || saving}
              onClick={() => setEditing(true)}
            >
              {custom ? "Edit selection" : "Customize"}
            </Button>
          </div>
        ) : null}
      </div>
      {resetting ? (
        <div className="grid gap-2 border-l-2 border-brand pl-3">
          <p className="text-sm">Remove this override?</p>
          <p className="text-xs text-fg-muted">
            New sessions will follow deployment defaults. This may enable tools missing from your
            custom selection. Existing sessions will not change.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={saving} onClick={() => void save(true)}>
              {saving ? "Saving…" : "Use deployment defaults"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setResetting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {editing ? (
        <div className="grid gap-2 border-l-2 border-brand pl-3">
          <p className="text-xs text-fg-muted">
            {permissions
              ? "Saving creates a fixed selection of built-in tools for new sessions. Connector selections are preserved. Nothing changes until you save."
              : "Connected apps are included automatically unless you choose a custom list. Nothing changes until you save."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={saving} onClick={() => void save(false)}>
              {saving ? "Saving…" : "Save custom selection"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setSelected(new Set(source));
                setSelectedMcp(new Set(defaults.mcpServerIds));
                setInheritConnectors(defaults.inheritConnectedMcpServers === true);
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="divide-y divide-border rounded-lg border border-border bg-surface px-3">
        {permissions ? (
          nativeServers.map((server) => (
            <div key={server.id} className="py-3">
              <ToolCheckbox
                label={builtInMcpCapability(server)!.name}
                state={selectedMcp.has(server.id)}
                disabled={disabled}
                onChange={() =>
                  setSelectedMcp((current) => {
                    const next = new Set(current);
                    if (next.has(server.id)) next.delete(server.id);
                    else next.add(server.id);
                    return next;
                  })
                }
              />
            </div>
          ))
        ) : (
          <div className="py-3">
            <ToolCheckbox
              label="Use connected apps automatically"
              state={inheritConnectors}
              disabled={disabled}
              onChange={() => {
                if (inheritConnectors) {
                  setSelected(
                    (current) =>
                      new Set([...current, ...connectedServers.map((server) => server.id)]),
                  );
                }
                setInheritConnectors((current) => !current);
              }}
            />
            <p className="mt-1 text-xs text-fg-muted">
              Include available MCP connections, including apps connected later. Each connector's
              tool permissions still apply.
            </p>
          </div>
        )}
        {permissions
          ? groups.map((group) => {
              const count = group.toolIds.filter((id) => selected.has(id)).length;
              return (
                <details key={group.id} className="py-3">
                  <summary className="cursor-pointer rounded text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                    {group.name}
                    <span className="ml-2 text-xs font-normal text-fg-muted">
                      {count} of {group.toolIds.length} enabled
                      {count > 0 && count < group.toolIds.length ? " · Partially enabled" : ""}
                    </span>
                  </summary>
                  <p className="mt-1 text-xs text-fg-muted">{group.description}</p>
                  <div className="mt-3 grid gap-2">
                    <ToolCheckbox
                      label="Enable all in this group"
                      state={count === 0 ? false : count === group.toolIds.length ? true : "mixed"}
                      disabled={disabled}
                      onChange={() => toggle(group.toolIds)}
                    />
                    {group.toolIds.map((id) => (
                      <ToolCheckbox
                        key={id}
                        label={firstPartyTools.find((tool) => tool.id === id)?.name ?? id}
                        detail={id}
                        state={selected.has(id)}
                        disabled={disabled}
                        onChange={() => toggle([id])}
                      />
                    ))}
                  </div>
                </details>
              );
            })
          : !inheritConnectors &&
            connectedServers.map((server) => (
              <div key={server.id} className="py-3">
                <ToolCheckbox
                  label={server.name}
                  state={selected.has(server.id)}
                  disabled={disabled}
                  onChange={() => toggle([server.id])}
                />
              </div>
            ))}
        {!permissions && connectedServers.length === 0 ? (
          <p className="py-3 text-xs text-fg-muted">
            No connectors are available in this workspace.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ToolCheckbox({
  label,
  detail,
  state,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  state: boolean | "mixed";
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-3 rounded px-1 text-sm">
      <input
        type="checkbox"
        checked={state === true}
        aria-checked={state}
        ref={(node) => {
          if (node) node.indeterminate = state === "mixed";
        }}
        disabled={disabled}
        onChange={onChange}
        className="size-4 accent-brand"
      />
      <span className="min-w-0 break-words">
        {label}
        {detail ? <span className="block text-xs text-fg-muted">{detail}</span> : null}
      </span>
    </label>
  );
}
