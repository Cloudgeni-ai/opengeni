/**
 * The Apps page (the rail's Apps): the apps here, each with its version and
 * "Customized" or "Update available", and the ready-made apps available to add.
 * Installing, updating and going back follow docs/app-packages.md.
 */
import type { AppPackageStatus, ArtifactCatalogItem } from "@opengeni/sdk";
import { AppWindowIcon, ArrowUpCircleIcon, PlusIcon, UndoIcon } from "lucide-react";
import { useState } from "react";

import { InstallAppButton, useAppPackageActions } from "../components/artifacts/app-package";
import { ArtifactLibrary, type ArtifactItemExtras } from "../components/artifacts/artifact-library";
import { AvailableApps } from "../components/artifacts/available-apps";
import { ArtifactSessionPage } from "../components/session/artifact-session-page";
import { useAppContext } from "../app-context";
import { artifactLibraryFilters, artifactLibrarySearch } from "../lib/artifact-library-navigation";
import type { ArtifactCatalogFilters } from "../lib/artifact-catalog";
import { useNavigate, useSearch } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import { readyNewChat } from "../lib/ready-new-chat";
import type { ArtifactReturnSearch } from "../lib/routes";
import { newArtifactPrompt } from "../lib/site-edit-prompt";
import { toast } from "../lib/toast";
import { useAppPackageStatus } from "../lib/use-app-package-status";
import { invalidateArtifactCatalog, useArtifactCatalog } from "../lib/use-artifact-catalog";
import { useArtifactCatalogMutationInvalidation } from "../lib/use-artifact-catalog-mutation-invalidation";
import { userErrorText } from "../../ui/api-error";
import { Button } from "../../ui/button";
import { ContentPage } from "../../ui/content-layout";
import { DropdownMenuItem } from "../../ui/dropdown-menu";
import { PageHeader } from "../../ui/page-header";
import { StatusBadge } from "../../ui/status-badge";

export function AppsRoute({
  workspaceId,
  fromSession,
  onChooseReadyMade,
}: {
  workspaceId: string;
  fromSession?: string | undefined;
  /** Opens a ready-made app's Enable page; without it, Available opens the install dialog. */
  onChooseReadyMade?: ((templateKey: string) => void) | undefined;
}) {
  return (
    <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
      <AppsPage
        key={workspaceId}
        workspaceId={workspaceId}
        fromSession={fromSession}
        onChooseReadyMade={onChooseReadyMade}
      />
    </ArtifactSessionPage>
  );
}

/** An installed app's badges and menu entries: version, Customized, Update, Restore. */
const CUSTOMIZED_HINT = "Customized apps don't get updates.";

export function appPackageExtras(
  status: AppPackageStatus | undefined,
  actions: {
    update: (status: AppPackageStatus) => void;
    restore: (status: AppPackageStatus) => void;
  } | null,
): ArtifactItemExtras | undefined {
  if (!status) return undefined;
  const badges = (
    <>
      {status.packageVersion ? (
        <span className="text-xs text-fg-subtle tabular-nums" data-app-version="">
          v{status.packageVersion}
        </span>
      ) : null}
      {status.customized ? (
        <span data-app-customized="">
          <StatusBadge tone="neutral" reason={CUSTOMIZED_HINT}>
            Customized
          </StatusBadge>
        </span>
      ) : null}
      {status.update && actions ? (
        <button
          type="button"
          className="cursor-pointer rounded-full"
          data-app-update=""
          onClick={() => actions.update(status)}
        >
          <StatusBadge tone="attention">Update available</StatusBadge>
        </button>
      ) : null}
    </>
  );
  const menu = actions ? (
    <>
      {status.update ? (
        <DropdownMenuItem onSelect={() => actions.update(status)}>
          <ArrowUpCircleIcon />
          Update to {status.update.packageVersion}
        </DropdownMenuItem>
      ) : null}
      {status.previous ? (
        <DropdownMenuItem onSelect={() => actions.restore(status)}>
          <UndoIcon />
          Restore previous version
        </DropdownMenuItem>
      ) : null}
    </>
  ) : null;
  return status.packageId ? { badges, menu, seed: status.packageId } : { badges, menu };
}

function AppsPage({
  workspaceId,
  fromSession,
  onChooseReadyMade,
}: {
  workspaceId: string;
  fromSession?: string | undefined;
  onChooseReadyMade?: ((templateKey: string) => void) | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ArtifactReturnSearch;
  const filters: ArtifactCatalogFilters = { ...artifactLibraryFilters(search), kind: "site" };
  const setFilters = (next: ArtifactCatalogFilters) => {
    const { kind: _kind, ...rest } = artifactLibrarySearch(next, fromSession);
    void navigate({
      to: "/workspaces/$workspaceId/apps",
      params: { workspaceId },
      search: rest,
      replace: true,
      resetScroll: false,
    });
  };
  const catalog = useArtifactCatalog(
    context.client,
    workspaceId,
    filters,
    context.accessKeyVersion,
  );
  const status = useAppPackageStatus(context.client, workspaceId);
  const actions = useAppPackageActions(workspaceId);
  const invalidateAfterMutation = useArtifactCatalogMutationInvalidation(
    context.client,
    workspaceId,
    invalidateArtifactCatalog,
  );
  const canCreate = hasWorkspacePermission(context.accessContext, workspaceId, "sessions:create");
  const canPublish = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "artifacts:publish",
  );
  const [preparingNew, setPreparingNew] = useState(false);
  const newApp = async () => {
    if (preparingNew) return;
    setPreparingNew(true);
    try {
      await readyNewChat(context.client, workspaceId, newArtifactPrompt("site"));
      await navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId } });
    } catch (error) {
      toast.error("Couldn't open a new chat", { description: userErrorText(error) });
    } finally {
      setPreparingNew(false);
    }
  };
  const newAppButton = canCreate ? (
    <Button
      type="button"
      onClick={() => void newApp()}
      disabled={context.busy || preparingNew}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      New app
    </Button>
  ) : null;
  const packageActions = canPublish && actions ? actions : null;
  const extras = (item: ArtifactCatalogItem) =>
    appPackageExtras(status.apps.get(item.id), packageActions);
  // Ready-made apps, not while searching or showing archived ones.
  const showAvailable =
    canPublish && status.loaded && filters.q.trim() === "" && filters.status === "active";
  return (
    <ContentPage width="standard" className="pt-6">
      <PageHeader
        icon={<AppWindowIcon />}
        title="Apps"
        description="Your team's apps, and ready-made ones to add"
        actions={
          <>
            {canPublish ? <InstallAppButton workspaceId={workspaceId} /> : null}
            {newAppButton}
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-8 pt-6">
        <ArtifactLibrary
          workspaceId={workspaceId}
          sessionId={fromSession}
          browseSearch={artifactLibrarySearch(filters, fromSession, true)}
          items={catalog.items}
          filters={filters}
          onFiltersChange={setFilters}
          loading={catalog.loading}
          error={catalog.error}
          onRetry={catalog.retry}
          nextCursor={catalog.nextCursor}
          onLoadMore={catalog.loadMore}
          empty={{
            title: "No apps yet",
            description: "Install a ready-made app below, or ask an agent to make one.",
          }}
          itemExtras={extras}
          onPin={
            canPublish
              ? async (item, pinned) => {
                  await context.client.updateArtifactPin(workspaceId, item.kind, item.id, pinned);
                  invalidateAfterMutation();
                  await catalog.refresh();
                }
              : undefined
          }
        />
        {showAvailable ? (
          <AvailableApps
            workspaceId={workspaceId}
            installed={[...status.apps.values()]}
            onChoose={onChooseReadyMade}
          />
        ) : null}
      </div>
      {packageActions?.element}
    </ContentPage>
  );
}
