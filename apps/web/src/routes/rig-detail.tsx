// A single rig: overview, setup/definition, version history, and the change
// queue. Reads poll so verification and promotion move live. All writes go
// through the rig hook; rigs:manage gates create/edit/promote/activate/delete,
// rigs:use gates read + propose.
import { useRig, useRigChanges, useRigVersions, useVariableSets } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, Loader2Icon, PencilIcon, ServerCogIcon, StarIcon, StarOffIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

import { PermissionDenied } from "@/routes/rigs";
import { RigChangesQueue } from "@/components/rigs/rig-changes-queue";
import { RigOverview } from "@/components/rigs/rig-overview";
import { RigSetupSection } from "@/components/rigs/rig-setup-section";
import { RigVersionsTimeline } from "@/components/rigs/rig-versions-timeline";
import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

// Live cadence: fast enough that a verifying change resolves without a manual
// refresh, slow enough to stay quiet.
const POLL_MS = 5000;

export function RigDetailRoute({ workspaceId, rigId }: { workspaceId: string; rigId: string }) {
  const context = useAppContext();
  const canView = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:use");
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:manage");

  const rig = useRig(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const versions = useRigVersions(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const changes = useRigChanges(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const variableSets = useVariableSets();
  const navigate = useNavigate();

  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const variableSetName = useMemo(() => {
    const byId = new Map(variableSets.variableSets.map((set) => [set.id, set.name]));
    return (id: string) => byId.get(id) ?? "Unknown variable set";
  }, [variableSets.variableSets]);

  const versionLabel = useMemo(() => {
    const byId = new Map(versions.versions.map((version) => [version.id, `v${version.version}`]));
    return (id: string | null) => (id ? byId.get(id) ?? null : null);
  }, [versions.versions]);

  const refreshAll = async () => {
    await Promise.all([rig.refresh(), versions.refresh(), changes.refresh()]);
  };

  if (!canView) {
    return (
      <Shell workspaceId={workspaceId}>
        <div className="mt-6">
          <PermissionDenied />
        </div>
      </Shell>
    );
  }

  if (rig.error && !rig.rig) {
    return (
      <Shell workspaceId={workspaceId}>
        <div className="mt-6">
          <LoadErrorState title="Couldn't load this rig" error={rig.error} onRetry={() => void refreshAll()} />
        </div>
      </Shell>
    );
  }

  if (!rig.rig) {
    return (
      <Shell workspaceId={workspaceId}>
        <div className="mt-6 grid gap-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="mt-3 h-40 w-full rounded-lg" />
        </div>
      </Shell>
    );
  }

  const current = rig.rig;
  const active = current.activeVersion;
  const pendingChanges = changes.changes.filter((change) => change.status === "proposed" || change.status === "verifying").length;
  const isDefaultRig = context.workspaces.find((workspace) => workspace.id === workspaceId)?.defaultRigId === current.id;

  return (
    <Shell workspaceId={workspaceId}>
      <div className="mt-4 flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          {editing ? (
            <RenameForm
              rig={current}
              mutating={rig.mutating}
              onCancel={() => setEditing(false)}
              onSave={async (patch) => {
                const result = await rig.update(patch);
                if (result) {
                  setEditing(false);
                  toast.success("Rig updated");
                }
                return result;
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-brand"><ServerCogIcon className="size-5" /></span>
                <h1 className="min-w-0 truncate text-lg font-semibold">{current.name}</h1>
                {active ? <MetaChip title="Active version">v{active.version}</MetaChip> : <MetaChip dot="queued">Draft</MetaChip>}
                {isDefaultRig ? (
                  <MetaChip
                    title="Workspace default — new sessions use this rig unless another is picked"
                    className="border-brand/30 text-brand"
                  >
                    <StarIcon className="size-3 shrink-0 fill-current" />
                    Default
                  </MetaChip>
                ) : null}
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-fg-muted">{current.description ?? "No description"}</p>
            </>
          )}
        </div>
        {!editing && canManage ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9"
              disabled={rig.mutating}
              onClick={async () => {
                const updated = await context.setWorkspaceDefaultRig(workspaceId, isDefaultRig ? null : current.id);
                if (updated) {
                  toast.success(isDefaultRig ? "Cleared the workspace default rig" : `“${current.name}” is now the workspace default`);
                }
              }}
            >
              {isDefaultRig ? <StarOffIcon className="size-3.5" /> : <StarIcon className="size-3.5" />}
              {isDefaultRig ? "Clear default" : "Set as default"}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete rig"
              className="hover:text-status-failed"
              disabled={rig.mutating}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {rig.mutationError ? (
        <Notice tone="failed" className="mt-4" action={(
          <Button type="button" variant="ghost" size="xs" onClick={rig.clearMutationError}>Dismiss</Button>
        )}>
          {rig.mutationError.message}
        </Notice>
      ) : null}

      <Tabs value={tab} onValueChange={setTab} className="mt-5 gap-0">
        <TabsList variant="line" className="h-9 gap-1">
          <TabsTrigger value="overview" className="px-3 text-xs">Overview</TabsTrigger>
          <TabsTrigger value="setup" className="px-3 text-xs">Setup</TabsTrigger>
          <TabsTrigger value="versions" className="px-3 text-xs">
            Versions
            <span className="ml-1.5 text-fg-subtle">{current.versionCount}</span>
          </TabsTrigger>
          <TabsTrigger value="changes" className="px-3 text-xs">
            Changes
            {pendingChanges > 0 ? <span className="ml-1.5 rounded-full bg-status-waiting/15 px-1.5 text-2xs font-medium text-status-waiting">{pendingChanges}</span> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-5">
          <RigOverview
            rig={current}
            changes={changes.changes}
            variableSetName={variableSetName}
            canUse={canView}
            mutating={rig.mutating}
            onVerify={rig.verify}
          />
        </TabsContent>

        <TabsContent value="setup" className="mt-5">
          <RigSetupSection
            activeVersion={active}
            variableSets={variableSets.variableSets}
            canPropose={canView}
            mutating={rig.mutating}
            onPropose={async (request) => {
              const result = await rig.proposeChange(request);
              await changes.refresh();
              return result;
            }}
            onProposed={() => setTab("changes")}
          />
        </TabsContent>

        <TabsContent value="versions" className="mt-5">
          {versions.error && versions.versions.length === 0 ? (
            <LoadErrorState title="Couldn't load versions" error={versions.error} onRetry={() => void versions.refresh()} />
          ) : (
            <RigVersionsTimeline
              versions={versions.versions}
              activeVersionId={active?.id ?? null}
              variableSetName={variableSetName}
              canManage={canManage}
              mutating={rig.mutating}
              onActivate={async (versionId) => {
                const result = await rig.activateVersion(versionId);
                await versions.refresh();
                return result;
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="changes" className="mt-5">
          {changes.error && changes.changes.length === 0 ? (
            <LoadErrorState title="Couldn't load changes" error={changes.error} onRetry={() => void changes.refresh()} />
          ) : (
            <RigChangesQueue
              changes={changes.changes}
              versionLabel={versionLabel}
              canManage={canManage}
              mutating={rig.mutating}
              onVerify={async (changeId) => {
                const result = await rig.verifyChange(changeId);
                await changes.refresh();
                return result;
              }}
              onPromote={async (changeId) => {
                const result = await rig.promoteChange(changeId);
                await Promise.all([versions.refresh(), changes.refresh()]);
                return result;
              }}
            />
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete rig “${current.name}”?`}
        description="Its versions and change history are removed. Sessions already running keep the version they materialized. This can't be undone."
        confirmLabel="Delete rig"
        onConfirm={async () => {
          const removed = await rig.remove();
          if (removed) {
            toast.success("Rig deleted");
            void navigate({ to: "/workspaces/$workspaceId/rigs", params: { workspaceId } });
          }
          return removed;
        }}
      />
    </Shell>
  );
}

function Shell({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <Link
        to="/workspaces/$workspaceId/rigs"
        params={{ workspaceId }}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeftIcon className="size-3.5" />
        Rigs
      </Link>
      {children}
    </div>
  );
}

function RenameForm({
  rig,
  mutating,
  onSave,
  onCancel,
}: {
  rig: { name: string; description: string | null };
  mutating: boolean;
  onSave: (patch: { name?: string; description?: string | null }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rig.name);
  const [description, setDescription] = useState(rig.description ?? "");
  return (
    <div className="grid max-w-xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="grid gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Rig name" className="h-9" autoFocus />
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" aria-label="Rig description" className="h-9" />
      </div>
      <div className="flex items-start gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          size="sm"
          className="h-9"
          disabled={mutating || !name.trim()}
          onClick={() => void onSave({ name: name.trim() || rig.name, description: description.trim() ? description.trim() : null })}
        >
          {mutating ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
          Save
        </Button>
      </div>
    </div>
  );
}
