// Rigs: workspace-scoped, versioned sandbox machine definitions. A rig is the
// team's machine — a base image + setup script + health checks + default
// variable sets, versioned and self-healing. This page lists them and creates
// new ones; the per-rig detail owns versions, changes, and promotion.
import { useRigs, useVariableSets } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  StarIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import {
  RigDefinitionFields,
  cleanRigChecks,
  emptyRigDefinitionDraft,
  type RigDefinitionDraft,
} from "@/components/rigs/rig-definition-fields";
import { RigStatusChip } from "@/components/rigs/rig-status-chip";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { formatTimestamp } from "@/lib/format";
import { rigCheckHealthView, versionHasChecks } from "@/lib/rig-status";
import { listViewState } from "@/lib/load-state";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { CreateRigRequest, Rig } from "@/types";

export function RigsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const canView = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:use");
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:manage");
  const rigs = useRigs({ enabled: canView });
  const defaultRigId =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.defaultRigId ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const rigsView = listViewState({
    loading: rigs.loading,
    error: rigs.error,
    count: rigs.rigs.length,
  });

  if (!canView) {
    return (
      <PageShell>
        <PageHeader
          icon={<ServerCogIcon className="size-4" />}
          title="Rigs"
          description="Versioned machine definitions for your sandboxes."
        />
        <div className="mt-6">
          <PermissionDenied />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        icon={<ServerCogIcon className="size-4" />}
        title="Rigs"
        description="The team's machine, versioned and self-healing: a base image, a setup script, and health checks that every sandbox on the rig materializes from."
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void rigs.refresh()}
              disabled={rigs.loading}
              className="h-9"
            >
              <RefreshCwIcon className={rigs.loading ? "size-3.5 animate-spin" : "size-3.5"} />
              Refresh
            </Button>
            {canManage ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen((open) => !open)}
                className="h-9"
              >
                <PlusIcon className="size-3.5" />
                New rig
              </Button>
            ) : null}
          </>
        }
      />

      {createOpen && canManage ? (
        <CreateRigForm
          mutating={rigs.mutating}
          onCancel={() => setCreateOpen(false)}
          onCreate={async (request) => {
            const created = await rigs.create(request);
            if (created) {
              setCreateOpen(false);
              toast.success(`Rig “${created.name}” created`);
            } else if (rigs.mutationError) {
              toast.error("Couldn't create rig", { description: rigs.mutationError.message });
            }
            return created;
          }}
        />
      ) : null}

      <div className="mt-5 grid gap-3">
        {rigsView === "loading" ? (
          <>
            {[0, 1].map((key) => (
              <div key={key} className="rounded-lg border border-border bg-surface/45 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
              </div>
            ))}
          </>
        ) : rigsView === "error" ? (
          <LoadErrorState
            title="Couldn't load rigs"
            error={rigs.error}
            onRetry={() => void rigs.refresh()}
          />
        ) : rigsView === "empty" ? (
          <EmptyState
            icon={<ServerCogIcon className="size-4" />}
            title="No rigs yet"
            description="A rig defines what a sandbox is — its image, setup, and health checks — versioned so the team's machine can evolve safely. Create one to get started."
            action={
              canManage ? (
                <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
                  <PlusIcon className="size-3.5" />
                  New rig
                </Button>
              ) : undefined
            }
          />
        ) : (
          rigs.rigs.map((rig) => (
            <RigCard
              key={rig.id}
              workspaceId={workspaceId}
              rig={rig}
              isDefault={rig.id === defaultRigId}
            />
          ))
        )}
        {rigs.mutationError ? (
          <Notice
            tone="failed"
            action={
              <Button type="button" variant="ghost" size="xs" onClick={rigs.clearMutationError}>
                Dismiss
              </Button>
            }
          >
            {rigs.mutationError.message}
          </Notice>
        ) : null}
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      {children}
    </div>
  );
}

export function PermissionDenied() {
  return (
    <Notice tone="muted" title="You don't have access to rigs">
      Ask a workspace admin for the “Rigs” permission to view and propose machine definitions.
    </Notice>
  );
}

function RigCard({
  workspaceId,
  rig,
  isDefault,
}: {
  workspaceId: string;
  rig: Rig;
  isDefault: boolean;
}) {
  const active = rig.activeVersion;
  const checkCount = active?.checks.length ?? 0;
  return (
    <Link
      to="/workspaces/$workspaceId/rigs/$rigId"
      params={{ workspaceId, rigId: rig.id }}
      className="group block rounded-lg border border-border bg-surface/45 p-3.5 transition-colors hover:border-border-strong hover:bg-surface"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{rig.name}</span>
            {active ? (
              <MetaChip title="Active version">v{active.version}</MetaChip>
            ) : (
              <MetaChip dot="queued" title="No active version yet">
                Draft
              </MetaChip>
            )}
            {isDefault ? (
              <MetaChip
                title="Workspace default — new sessions use this rig unless another is picked"
                className="border-brand/30 text-brand"
              >
                <span className="inline-flex items-center gap-1">
                  <StarIcon className="size-3 shrink-0 fill-current" />
                  Default
                </span>
              </MetaChip>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-fg-muted">
            {rig.description ?? "No description"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {active && versionHasChecks(active) ? (
              // Last verification's pass/fail/unknown for the active version. The
              // list payload carries the summary (activeVersionHealth); `unknown`
              // (or a missing summary) reads as a neutral "Not verified".
              <RigStatusChip
                view={rigCheckHealthView(rig.activeVersionHealth?.checkHealth ?? "unknown")}
              />
            ) : null}
            <MetaChip title={active?.image ?? "Falls back to the deployment default image"}>
              {active?.image ? active.image : "Default image"}
            </MetaChip>
            <MetaChip title="Declared health checks on the active version">
              {checkCount === 0 ? "No checks" : `${checkCount} check${checkCount === 1 ? "" : "s"}`}
            </MetaChip>
            <span className="text-2xs text-fg-subtle">
              {rig.versionCount} version{rig.versionCount === 1 ? "" : "s"} · updated{" "}
              {formatTimestamp(rig.updatedAt)}
            </span>
          </div>
        </div>
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted" />
      </div>
    </Link>
  );
}

function CreateRigForm({
  mutating,
  onCreate,
  onCancel,
}: {
  mutating: boolean;
  onCreate: (request: CreateRigRequest) => Promise<Rig | null>;
  onCancel: () => void;
}) {
  const variableSets = useVariableSets();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [definition, setDefinition] = useState<RigDefinitionDraft>(emptyRigDefinitionDraft());

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Rig name is required");
      return;
    }
    await onCreate({
      name: trimmed,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(definition.image.trim() ? { image: definition.image.trim() } : {}),
      ...(definition.setupScript.trim() ? { setupScript: definition.setupScript } : {}),
      checks: cleanRigChecks(definition.checks),
      credentialHooks: [],
      defaultVariableSetIds: definition.defaultVariableSetIds,
    });
  }

  return (
    <div className="mt-4 grid gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="rig-name">Name</Label>
          <Input
            id="rig-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="dev-machine"
            className="h-9"
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rig-description">Description</Label>
          <Input
            id="rig-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this machine is for"
            className="h-9"
          />
        </div>
      </div>

      <details
        className="group"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg">
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
          Image, setup script &amp; checks
          <span className="text-fg-subtle">
            — optional; you can add these later as verified changes
          </span>
        </summary>
        <div className="mt-3 border-t border-border/70 pt-3">
          <RigDefinitionFields
            value={definition}
            onChange={setDefinition}
            variableSets={variableSets.variableSets}
            disabled={mutating}
            idPrefix="create-rig"
          />
        </div>
      </details>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-9"
          disabled={mutating || !name.trim()}
          onClick={() => void submit()}
        >
          {mutating ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
          Create rig
        </Button>
      </div>
    </div>
  );
}
