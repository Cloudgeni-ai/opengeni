import {
  resolveWorkspaceSessionToolDefaults,
  type FirstPartyMcpToolName,
  type WorkspaceSessionToolDefaults,
} from "@opengeni/contracts";
import { Loader2Icon, PlugIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PreferenceToggleRow } from "@/components/transcription-settings";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import {
  builtInMcpCapability,
  capabilityGroupSelection,
  sessionCapabilityGroupsFor,
  type SessionCapabilityGroup,
} from "@/lib/session-capabilities";
import {
  clientFirstPartyMcpToolPolicy,
  firstPartySessionToolOptionsFor,
  type McpServerOption,
} from "@/lib/session-tools";
import { cn } from "@/lib/utils";

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

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
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const deploymentPolicy = useMemo(
    () => clientFirstPartyMcpToolPolicy(context.clientConfig),
    [context.clientConfig],
  );
  const firstPartyTools = useMemo(
    () => firstPartySessionToolOptionsFor(deploymentPolicy.allowed),
    [deploymentPolicy],
  );
  const configured = useMemo(
    () => resolveWorkspaceSessionToolDefaults(workspace?.settings),
    [workspace?.settings],
  );
  const serverIds = useMemo(
    () => new Set(context.toolMcpServers.map((server) => server.id)),
    [context.toolMcpServers],
  );
  const defaults = useMemo<WorkspaceSessionToolDefaults>(
    () => ({
      mcpServerIds: configured
        ? configured.mcpServerIds.filter((id) => serverIds.has(id))
        : context.toolMcpServers.map((server) => server.id),
      firstPartyMcpTools: configured
        ? configured.firstPartyMcpTools.filter((tool) => deploymentPolicy.allowed.includes(tool))
        : deploymentPolicy.default,
    }),
    [configured, context.toolMcpServers, deploymentPolicy, serverIds],
  );

  return (
    <WorkspaceCapabilityDefaultsView
      servers={context.toolMcpServers}
      firstPartyTools={firstPartyTools}
      defaults={defaults}
      revisionKey={workspace?.updatedAt ?? workspaceId}
      canManage={canManage}
      kind={kind}
      onSave={async (next) => {
        const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
        if (!acceptedTransition) return false;
        const updated = await context.updateWorkspaceSettings(workspaceId, {
          sessionToolDefaults: next,
        });
        if (!updated || !context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
          return false;
        }
        toast.success(
          kind === "permissions"
            ? "Default agent permissions updated"
            : "Default session plugins updated",
        );
        return true;
      }}
    />
  );
}

/** Exact production view, also reused by the DEV approval gallery. */
export function WorkspaceCapabilityDefaultsView({
  servers,
  firstPartyTools,
  defaults,
  revisionKey,
  canManage,
  kind,
  onSave,
}: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  defaults: WorkspaceSessionToolDefaults;
  revisionKey: string;
  canManage: boolean;
  kind: "permissions" | "plugins";
  onSave: (defaults: WorkspaceSessionToolDefaults) => Promise<boolean>;
}) {
  const groups = useMemo(() => sessionCapabilityGroupsFor(firstPartyTools), [firstPartyTools]);
  const openGeniGroups = groups.filter((group) => group.kind === "opengeni");
  const connectedAppGroups = groups.filter((group) => group.kind === "connected_app");
  const builtInServers = servers.flatMap((server) => {
    const capability = builtInMcpCapability(server);
    return capability ? [{ server, capability }] : [];
  });
  const connectedServers = servers.filter((server) => !builtInMcpCapability(server));
  const [mcpIds, setMcpIds] = useState(() => new Set(defaults.mcpServerIds));
  const [firstPartyIds, setFirstPartyIds] = useState(
    () => new Set<FirstPartyMcpToolName>(defaults.firstPartyMcpTools),
  );
  const [saving, setSaving] = useState(false);
  const sourceKey = `${revisionKey}\u0000${sorted(defaults.mcpServerIds).join("\u0000")}\u0001${sorted(
    defaults.firstPartyMcpTools,
  ).join("\u0000")}`;

  useEffect(() => {
    setMcpIds(new Set(defaults.mcpServerIds));
    setFirstPartyIds(new Set(defaults.firstPartyMcpTools));
    // The caller's exact revision owns this reset. Derived array identity is
    // intentionally excluded so ordinary renders never discard local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  const dirty =
    sorted(mcpIds).join("\u0000") !== sorted(defaults.mcpServerIds).join("\u0000") ||
    sorted(firstPartyIds).join("\u0000") !== sorted(defaults.firstPartyMcpTools).join("\u0000");

  const toggleMcp = (id: string) => {
    setMcpIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleGroup = (group: SessionCapabilityGroup) => {
    setFirstPartyIds((current) => {
      const next = new Set(current);
      const enable = capabilityGroupSelection(group, current) !== "all";
      for (const tool of group.toolIds) {
        if (enable) next.add(tool);
        else next.delete(tool);
      }
      return next;
    });
  };
  const save = async () => {
    if (!canManage || saving || !dirty) return;
    setSaving(true);
    try {
      await onSave({
        mcpServerIds: sorted(mcpIds),
        firstPartyMcpTools: sorted(firstPartyIds),
      });
    } finally {
      setSaving(false);
    }
  };

  const permissions = kind === "permissions";

  return (
    <section aria-labelledby="workspace-tool-defaults-heading" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workspace-tool-defaults-heading" className="text-sm font-medium">
            {permissions ? "Built-in permissions" : "Plugins for new sessions"}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            {permissions
              ? "Control OpenGeni actions such as knowledge, delegation, browser use, and workspace operations."
              : "Selected apps and MCP servers are included when they are installed and available in this workspace."}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canManage || saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <CapabilitySectionLabel>
          {permissions ? "OpenGeni" : "Plugin access"}
        </CapabilitySectionLabel>
        <div className="divide-y divide-border/70 px-3">
          {permissions
            ? builtInServers.map(({ server, capability }) => (
                <PreferenceToggleRow
                  key={server.id}
                  icon={<PlugIcon className="size-3.5 text-brand" />}
                  label={capability.name}
                  description={capability.description}
                  checked={mcpIds.has(server.id)}
                  disabled={!canManage || saving}
                  wrapDescription
                  onToggle={() => toggleMcp(server.id)}
                />
              ))
            : connectedServers.map((server) => (
                <PreferenceToggleRow
                  key={server.id}
                  icon={<PlugIcon className="size-3.5 text-brand" />}
                  label={server.name}
                  description="Available to agents through this workspace connection."
                  checked={mcpIds.has(server.id)}
                  disabled={!canManage || saving}
                  wrapDescription
                  onToggle={() => toggleMcp(server.id)}
                />
              ))}
          {(permissions ? openGeniGroups : connectedAppGroups).map((group) => (
            <CapabilityDefaultRow
              key={group.id}
              name={group.name}
              description={group.description}
              state={capabilityGroupSelection(group, firstPartyIds)}
              disabled={!canManage || saving}
              onToggle={() => toggleGroup(group)}
            />
          ))}
          {!permissions && connectedServers.length === 0 && connectedAppGroups.length === 0 ? (
            <p className="px-1 py-3 text-xs text-fg-subtle">
              Connected plugins appear here after they are added on the Plugins page.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CapabilitySectionLabel({ children }: { children: string }) {
  return (
    <div className="border-b border-border px-3 py-2">
      <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{children}</p>
    </div>
  );
}

function CapabilityDefaultRow(props: {
  name: string;
  description: string;
  state: "all" | "some" | "none";
  disabled: boolean;
  onToggle: () => void;
}) {
  const enabled = props.state !== "none";
  return (
    <div className="flex min-h-11 items-center gap-3 px-1 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{props.name}</span>
          {props.state === "some" ? (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">
              Custom
            </span>
          ) : null}
        </div>
        <p className="text-2xs leading-4 text-fg-subtle" title={props.description}>
          {props.description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={props.name}
        disabled={props.disabled}
        onClick={props.onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          enabled ? "border-brand bg-brand" : "border-border bg-surface-2",
        )}
      >
        <span
          className={cn(
            "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
            enabled ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
