import { machineCanBeWorkspaceDefault } from "@opengeni/contracts";
import type { MemberDefaultExecutionTarget } from "@opengeni/sdk";
import { workspaceDefaultMachine } from "@opengeni/react/app/lib/workspace-default-machine";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RowSelect } from "@opengeni/react/app/components/settings/row-select";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { useAppContext } from "@opengeni/react/app/app-context";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { canManageWorkspaceSettings } from "@opengeni/react/app/lib/permissions";
import { useWorkspaceMachines } from "@opengeni/react/app/lib/use-workspace-machines";

const FOLLOW_WORKSPACE = "workspace";

/**
 * "Your default machine" in a shared workspace: where the chats you start
 * yourself begin, ahead of the workspace default. Any machine you can use
 * qualifies, including your own Only me machines. Nobody else sees it, and
 * automations keep following the workspace default.
 */
export function MyDefaultMachineRow({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId);
  const fleet = useWorkspaceMachines({ workspaceId });
  const [state, setState] = useState<MemberDefaultExecutionTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const client = context.client;
  const shared = workspace !== undefined && workspace.kind !== "personal";
  useEffect(() => {
    if (!shared) return;
    let cancelled = false;
    setState(null);
    client
      .getMyDefaultExecutionTarget(workspaceId)
      .then((value) => {
        if (!cancelled) setState(value);
      })
      .catch(() => {
        if (!cancelled) setState({ target: null, usable: false });
      });
    return () => {
      cancelled = true;
    };
  }, [client, shared, workspaceId]);
  if (!shared) return null;
  const backend = context.clientConfig.defaultSandboxBackend;
  const managedAvailable = backend !== "selfhosted" && backend !== "none";
  const target = state?.target ?? null;
  const current =
    target?.kind === "machine"
      ? target.targetSandboxId
      : target?.kind === "managed"
        ? "managed"
        : FOLLOW_WORKSPACE;
  const machines = fleet.machines.filter(
    (item) => item.kind === "selfhosted" && !item.isSessionGroup,
  );
  const unavailable =
    target?.kind === "machine" &&
    !fleet.loading &&
    (state?.usable === false || !machines.some((item) => item.sandboxId === current));
  const workspaceTarget = workspaceDefaultMachine(workspace.settings);
  const workspaceDefaultLabel =
    workspaceTarget?.kind === "machine"
      ? (fleet.machines.find((item) => item.sandboxId === workspaceTarget.targetSandboxId)?.name ??
        "a shared machine")
      : workspaceTarget?.kind === "managed" || managedAvailable
        ? "Managed sandbox"
        : null;
  async function choose(value: string) {
    if (saving || value === current) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    setSaving(true);
    try {
      const next = await client.setMyDefaultExecutionTarget(
        workspaceId,
        value === FOLLOW_WORKSPACE
          ? null
          : value === "managed"
            ? { kind: "managed" }
            : { kind: "machine", targetSandboxId: value },
      );
      if (context.ownsWorkspaceInvocation(workspaceId, invocation)) setState(next);
    } catch (error) {
      if (context.ownsWorkspaceInvocation(workspaceId, invocation))
        toast.error("Couldn't change your default machine", {
          description: userErrorText(error),
        });
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingRow
      label="Your default machine"
      description={
        unavailable
          ? "Machine unavailable. Your new chats use the workspace default until you choose again."
          : "Where the chats you start begin. Only you see this; automations use the workspace default."
      }
      controlWidth="select"
      control={
        <RowSelect
          value={state ? current : null}
          placeholder="Choose a machine"
          loading={state === null || fleet.loading}
          disabled={saving}
          onValueChange={(value) => void choose(value)}
          options={[
            {
              value: FOLLOW_WORKSPACE,
              label: "Workspace default",
              description: workspaceDefaultLabel ?? undefined,
            },
            ...(managedAvailable ? [{ value: "managed", label: "Managed sandbox" }] : []),
            ...machines.map((item) => ({
              value: item.sandboxId,
              label: item.name,
              description:
                item.scope === "user"
                  ? item.state === "online"
                    ? "Only me"
                    : "Only me · Offline"
                  : item.state === "online"
                    ? undefined
                    : "Offline",
            })),
            ...(unavailable && target?.kind === "machine"
              ? [{ value: target.targetSandboxId, label: "Machine unavailable" }]
              : []),
          ]}
        />
      }
    />
  );
}

export function DefaultMachineRow({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId);
  const fleet = useWorkspaceMachines({ workspaceId });
  const [saving, setSaving] = useState(false);
  // Like the workspace's other settings: its administrators, or the owner of a
  // Personal workspace (who never holds workspace:admin there).
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace ?? null,
    context.managedSelfContext,
  );
  const target = workspaceDefaultMachine(workspace?.settings);
  const backend = context.clientConfig.defaultSandboxBackend;
  const current =
    target?.kind === "machine"
      ? target.targetSandboxId
      : target?.kind === "managed" || (backend !== "selfhosted" && backend !== "none")
        ? "managed"
        : backend === "none"
          ? "none"
          : null;
  const machines = fleet.machines.filter(
    (item) =>
      item.kind === "selfhosted" &&
      !item.isSessionGroup &&
      machineCanBeWorkspaceDefault(item, workspace),
  );
  const unavailable =
    target?.kind === "machine" &&
    !fleet.loading &&
    !machines.some((item) => item.sandboxId === current);
  // A personal machine runs only the automations it is chosen on, never one
  // that merely follows the workspace default.
  const personalDefault =
    target?.kind === "machine" &&
    machines.some((item) => item.sandboxId === current && item.scope === "user");
  async function choose(value: string) {
    if (!canManage || saving || (value === current && target !== null)) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    setSaving(true);
    try {
      await context.updateWorkspaceSettings(workspaceId, {
        defaultExecutionTarget:
          value === "none"
            ? null
            : value === "managed"
              ? { kind: "managed" }
              : { kind: "machine", targetSandboxId: value },
      });
    } catch (error) {
      if (context.ownsWorkspaceInvocation(workspaceId, invocation))
        toast.error("Couldn't change the default machine", {
          description: userErrorText(error),
        });
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingRow
      label="Default machine"
      description={
        unavailable
          ? "Machine unavailable. Choose a replacement to start new chats."
          : personalDefault
            ? "Used by new chats. Automations run on your own machine only when you choose it on the automation."
            : "Used by new chats and automations following the workspace default."
      }
      controlWidth="select"
      control={
        <RowSelect
          value={current}
          placeholder="Choose a machine"
          loading={fleet.loading}
          disabled={!canManage || saving}
          disabledReason={canManage ? undefined : "Only workspace administrators can change this."}
          onValueChange={(value) => void choose(value)}
          options={[
            ...(backend === "none"
              ? [{ value: "none", label: "No computer" }]
              : [
                  {
                    value: "managed",
                    label:
                      context.clientConfig.defaultSandboxBackend === "none"
                        ? "No computer"
                        : "Managed sandbox",
                    disabled: context.clientConfig.defaultSandboxBackend === "selfhosted",
                    disabledReason: "This server requires a connected machine.",
                  },
                ]),
            ...machines.map((item) => ({
              value: item.sandboxId,
              label: item.name,
              description: item.state === "online" ? undefined : "Offline",
            })),
            ...(unavailable && target?.kind === "machine"
              ? [{ value: target.targetSandboxId, label: "Machine unavailable" }]
              : []),
          ]}
        />
      }
    />
  );
}
