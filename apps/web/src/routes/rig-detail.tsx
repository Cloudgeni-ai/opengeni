// One sandbox environment as its own page: Overview, Versions and Changes
// tabs, a quiet aside, and Edit details / Edit setup as their own pages
// (?view=edit, ?view=edit-setup). Reads poll so verification and promotion
// move live. rigs:manage gates edit/promote/activate/default/delete;
// rigs:use gates read + propose.
import {
  useOpenGeni,
  useRig,
  useRigChanges,
  useRigVersions,
  useVariableSets,
} from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import {
  BoxIcon,
  Building2Icon,
  ContainerIcon,
  MoreHorizontalIcon,
  PencilIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { rigHealth } from "@/components/rigs/rig-health";
import { RigChangesQueue } from "@/components/rigs/rig-changes-queue";
import { RigOverview } from "@/components/rigs/rig-overview";
import { RigSetupEditPage } from "@/components/rigs/rig-setup-section";
import { RigVersionsTimeline } from "@/components/rigs/rig-versions-timeline";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FlushFormPage } from "@/components/ui/flush-form-page";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { resourceScopeLabel } from "@/components/resource-scope-picker";
import { errorParts, userFacingError } from "@/components/variable-sets/variable-set-model";
import { LoadFailure } from "@/components/variable-sets/variable-set-pages";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { rigActorLabel } from "@/lib/rig-status";
import { PermissionDenied, RigScopeChip } from "@/routes/rigs";
import type { Rig } from "@/types";

// Live cadence: fast enough that a verifying change resolves without a manual
// refresh, slow enough to stay quiet.
const POLL_MS = 5000;

type Tab = "overview" | "versions" | "changes";

const SCOPE_ICON = {
  workspace: <BoxIcon />,
  organization: <Building2Icon />,
  user: <UserIcon />,
} as const;

export function RigDetailRoute({
  workspaceId,
  rigId,
  view,
}: {
  workspaceId: string;
  rigId: string;
  view?: "edit" | "edit-setup";
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { client } = useOpenGeni();
  const canView = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:use");
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:manage");

  const rig = useRig(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const versions = useRigVersions(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const changes = useRigChanges(rigId, { enabled: canView, pollIntervalMs: POLL_MS });
  const variableSets = useVariableSets();

  const [tab, setTab] = useState<Tab>("overview");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const variableSetName = useMemo(() => {
    const byId = new Map(variableSets.variableSets.map((set) => [set.id, set.name]));
    return (id: string) => byId.get(id) ?? "Variable set you can't see";
  }, [variableSets.variableSets]);

  const versionLabel = useMemo(() => {
    const byId = new Map(versions.versions.map((version) => [version.id, `v${version.version}`]));
    return (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  }, [versions.versions]);

  const refreshAll = async () => {
    await Promise.all([rig.refresh(), versions.refresh(), changes.refresh()]);
  };
  const openList = () =>
    void navigate({ to: "/workspaces/$workspaceId/rigs", params: { workspaceId } });
  const openRig = (search: { view?: "edit" | "edit-setup" } = {}) =>
    void navigate({
      to: "/workspaces/$workspaceId/rigs/$rigId",
      params: { workspaceId, rigId },
      search,
    });

  const root = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const heading = root.current?.querySelector<HTMLElement>("h1");
    if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    root.current?.scrollIntoView?.({ block: "start" });
  }, [view]);

  const back = { label: "Sandbox environments", onClick: openList };
  const frame = (children: ReactNode) => (
    <ContentPage width="standard">
      <div ref={root} className="min-w-0 pb-7">
        {children}
      </div>
    </ContentPage>
  );

  if (!canView) {
    return frame(
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <PermissionDenied />
      </DetailPage>,
    );
  }

  if (rig.error && !rig.rig) {
    return frame(
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <LoadFailure
          title="Couldn't load this sandbox environment"
          error={rig.error}
          onRetry={() => void refreshAll()}
        />
      </DetailPage>,
    );
  }

  if (!rig.rig) {
    return frame(
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <div role="status" aria-label="Loading sandbox environment" className="min-w-0">
          <div aria-hidden="true" className="flex items-start gap-4">
            <Skeleton className="size-10 shrink-0 rounded-[10px] bg-surface-2" />
            <div className="min-w-0 flex-1 pt-1">
              <Skeleton className="h-5 w-48 rounded-full bg-surface-3" />
              <Skeleton className="mt-3 h-3.5 w-80 max-w-full rounded-full bg-surface-2" />
            </div>
          </div>
          <Skeleton className="mt-8 h-40 w-full rounded-[14px] bg-surface-2" />
        </div>
      </DetailPage>,
    );
  }

  const current = rig.rig;
  const active = current.activeVersion;
  const pendingChanges = changes.changes.filter(
    (change) => change.status === "proposed" || change.status === "verifying",
  ).length;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const isDefaultRig = workspace?.defaultRigId === current.id;
  const health = rigHealth(current);

  if (view === "edit" && canManage) {
    return frame(
      <EditRigDetailsPage
        rig={current}
        onClose={() => openRig()}
        onSave={async (patch) => {
          try {
            await client.updateRig(workspaceId, current.id, patch);
          } catch (error) {
            throw userFacingError(error);
          }
          await rig.refresh();
          toast.success("Saved");
          openRig();
        }}
      />,
    );
  }

  if (view === "edit-setup" && active) {
    return frame(
      <RigSetupEditPage
        rigName={current.name}
        activeVersion={active}
        rigScope={current.scope}
        variableSets={variableSets.variableSets}
        onClose={() => openRig()}
        onPropose={async (request) => {
          try {
            await client.proposeRigChange(workspaceId, current.id, request);
          } catch (error) {
            throw userFacingError(error);
          }
          await changes.refresh();
          toast.success("Change proposed", {
            description: "It's being checked in a clean sandbox before it can merge.",
          });
          setTab("changes");
          openRig();
        }}
      />,
    );
  }

  async function toggleDefault() {
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    const updated = await context.setWorkspaceDefaultRig(
      workspaceId,
      isDefaultRig ? null : current.id,
    );
    if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
      toast.success(
        isDefaultRig
          ? "New sessions no longer use a default environment"
          : `New sessions now use ${current.name}`,
      );
    }
  }

  const aside = (
    <DetailAside label={`About ${current.name}`}>
      {current.description ? (
        <DetailAsideItem label="Description">{current.description}</DetailAsideItem>
      ) : null}
      <DetailAsideItem label="Available to" icon={SCOPE_ICON[current.scope]}>
        {current.scope === "workspace" ? "This workspace" : resourceScopeLabel(current.scope)}
      </DetailAsideItem>
      <DetailAsideItem label="Workspace default">
        {isDefaultRig ? "Yes. New sessions use it." : "No"}
      </DetailAsideItem>
      {active ? (
        <DetailAsideItem label="Active version">
          Version {active.version}
          <span className="block text-xs leading-4.5 text-fg-muted">
            {rigActorLabel(active.createdBy)} · <RelativeTime date={active.createdAt} inSentence />
          </span>
        </DetailAsideItem>
      ) : null}
      <DetailAsideItem label="Last changed">
        <RelativeTime date={current.updatedAt} />
      </DetailAsideItem>
      {canManage ? (
        <div className="border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="-ml-2.5 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
          >
            <Trash2Icon aria-hidden="true" />
            Delete environment
          </Button>
        </div>
      ) : null}
    </DetailAside>
  );

  return frame(
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <LineTabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <DetailPageHeader
          leading={<LogoTile icon={<ContainerIcon />} />}
          title={current.name}
          chips={
            <>
              {isDefaultRig ? (
                <MetaChip title="New sessions in this workspace use it">Default</MetaChip>
              ) : null}
              {current.scope !== "workspace" ? <RigScopeChip scope={current.scope} /> : null}
            </>
          }
          meta={[
            <span key="version">{active ? `Version ${active.version}` : "No active version"}</span>,
            active ? <span key="health">{health.label.toLocaleLowerCase()}</span> : null,
            <span key="updated">
              updated <RelativeTime date={current.updatedAt} inSentence />
            </span>,
          ]}
          actions={
            <>
              {active ? (
                <Button
                  type="button"
                  onClick={() => openRig({ view: "edit-setup" })}
                  className="pointer-coarse:h-11"
                >
                  <PencilIcon aria-hidden="true" />
                  Edit setup
                </Button>
              ) : null}
              {canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`More actions for ${current.name}`}
                      disabled={rig.mutating}
                      className="text-fg-muted hover:text-fg pointer-coarse:size-11"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem onSelect={() => void toggleDefault()}>
                      {isDefaultRig ? (
                        <StarOffIcon aria-hidden="true" />
                      ) : (
                        <StarIcon aria-hidden="true" />
                      )}
                      {isDefaultRig ? "Stop using as default" : "Use for new sessions"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openRig({ view: "edit" })}>
                      <PencilIcon aria-hidden="true" />
                      Edit details
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                      <Trash2Icon aria-hidden="true" />
                      Delete environment
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          }
          tabs={
            <LineTabsList aria-label={`${current.name} sections`}>
              <LineTabsTrigger value="overview">Overview</LineTabsTrigger>
              <LineTabsTrigger value="versions" count={current.versionCount}>
                Versions
              </LineTabsTrigger>
              <LineTabsTrigger
                value="changes"
                count={pendingChanges > 0 ? pendingChanges : undefined}
                countTone="attention"
                countLabel={pendingChanges > 0 ? `${pendingChanges} waiting for review` : undefined}
              >
                Changes
              </LineTabsTrigger>
            </LineTabsList>
          }
        />
        {rig.mutationError ? (
          <ErrorMessage
            variant="inline"
            announce
            className="mt-6"
            title={errorParts(rig.mutationError).message}
            action={
              <Button type="button" variant="ghost" size="xs" onClick={rig.clearMutationError}>
                Dismiss
              </Button>
            }
          />
        ) : null}
        <DetailPageBody aside={aside}>
          <div className="min-w-0">
            <LineTabsContent value="overview">
              <div className="flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border">
                <RigOverview
                  rig={current}
                  changes={changes.changes}
                  variableSetName={variableSetName}
                  canUse={canView}
                  mutating={rig.mutating}
                  onVerify={rig.verify}
                  onOpenVariableSet={(id) =>
                    void navigate({
                      to: "/workspaces/$workspaceId/variable-sets/$variableSetId",
                      params: { workspaceId, variableSetId: id },
                    })
                  }
                />
              </div>
            </LineTabsContent>
            <LineTabsContent value="versions">
              <DetailSection>
                <p className="mb-4 text-sm leading-5 text-fg-muted">
                  Every promoted change becomes a version. New sessions start from the active one.
                </p>
                {versions.error && versions.versions.length === 0 ? (
                  <LoadFailure
                    title="Couldn't load versions"
                    error={versions.error}
                    onRetry={() => void versions.refresh()}
                  />
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
              </DetailSection>
            </LineTabsContent>
            <LineTabsContent value="changes">
              <DetailSection>
                <p className="mb-4 text-sm leading-5 text-fg-muted">
                  Proposed changes are checked in a clean sandbox before they merge.
                </p>
                {changes.error && changes.changes.length === 0 ? (
                  <LoadFailure
                    title="Couldn't load changes"
                    error={changes.error}
                    onRetry={() => void changes.refresh()}
                  />
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
              </DetailSection>
            </LineTabsContent>
          </div>
        </DetailPageBody>
      </LineTabs>

      <DestructiveConfirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${current.name}?`}
        consequences={[
          `Its ${current.versionCount === 1 ? "version" : `${current.versionCount} versions`} and change history go with it.`,
          ...(isDefaultRig
            ? ["New sessions in this workspace stop using a default environment."]
            : []),
          "Sessions already running keep the version they started with.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete environment"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          try {
            await client.deleteRig(workspaceId, current.id);
          } catch (error) {
            throw userFacingError(error);
          }
          toast.success(`Deleted ${current.name}`);
          openList();
        }}
      />
    </DetailPage>,
  );
}

function EditRigDetailsPage({
  rig,
  onClose,
  onSave,
}: {
  rig: Rig;
  onClose: () => void;
  onSave: (patch: { name: string; description: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(rig.name);
  const [description, setDescription] = useState(rig.description ?? "");
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const changed = trimmed !== rig.name || description.trim() !== (rig.description ?? "");
  return (
    <FlushFormPage
      backLabel={rig.name}
      onClose={onClose}
      title="Edit details"
      description={`The name and description of ${rig.name}.`}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      submitDisabled={!changed}
      onSubmit={async () => {
        setTried(true);
        if (!trimmed) return false;
        await onSave({
          name: trimmed,
          description: description.trim() ? description.trim() : null,
        });
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={tried && !trimmed ? "Name the environment." : undefined}>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            suppressAutofill
            autoComplete="off"
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            autoComplete="off"
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}
