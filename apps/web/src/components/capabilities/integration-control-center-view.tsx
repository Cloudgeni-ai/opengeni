import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudIcon,
  Layers3Icon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { RefObject } from "react";

import { CustomApiSection } from "@/components/capabilities/custom-api-section";
import { CustomApiSetupDialog } from "@/components/capabilities/custom-api-setup-dialog";
import type { CustomApiFlowState } from "@/components/capabilities/custom-api-flow";
import { GoogleDriveKnowledgeSourceDialog } from "@/components/capabilities/google-drive-knowledge-source-dialog";
import {
  IntegrationConnectDialog,
  IntegrationExperienceIcon,
  type IntegrationConnectRequest,
} from "@/components/capabilities/integration-connect-dialog";
import { IntegrationFacetsPanel } from "@/components/capabilities/integration-facets-panel";
import { integrationExperience } from "@/components/capabilities/integration-experience";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
  ConnectionMetadata,
} from "@/types";

export type IntegrationRemoveTarget = {
  instance: ApiIntegrationInstallationSummary;
  removesDefinition: boolean;
};

export function IntegrationControlCenterView({
  client,
  workspaceId,
  definitions,
  instancesByDefinition,
  customInstances,
  connections,
  loading,
  loadError,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  busyKey,
  callbackBusy,
  setupDefinition,
  setupInitialAccountLabel,
  removeTarget,
  customApi,
  embedded,
  showCustomApis,
  refreshRevision,
  onRefresh,
  onOpenSetup,
  onReconnect,
  onPreviewRemove,
  onSetupClose,
  onConnectSetup,
  onRemoveClose,
  onRemoveInstance,
  removeTriggerRef,
  setupTriggerRef,
  focusFallbackRef,
  onOpenCustomApi,
  onUpdateCustomApi,
  onReconnectCustomApi,
  onCustomApiOpenChange,
  onCustomApiDraftChange,
  onCustomApiPreview,
  onCustomApiAuthenticate,
  onCustomApiInstall,
  onCustomApiBack,
  onCustomApiToggleTool,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instancesByDefinition: Map<string, ApiIntegrationInstallationSummary[]>;
  customInstances: ApiIntegrationInstallationSummary[];
  connections: ConnectionMetadata[] | null;
  loading: boolean;
  loadError: string | null;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  busyKey: string | null;
  callbackBusy: boolean;
  setupDefinition: IntegrationDefinitionSummary | null;
  setupInitialAccountLabel: string;
  removeTarget: IntegrationRemoveTarget | null;
  customApi: CustomApiFlowState;
  embedded: boolean;
  showCustomApis: boolean;
  refreshRevision: number;
  onRefresh: () => void;
  onOpenSetup: (definition: IntegrationDefinitionSummary) => void;
  onReconnect: (instance: ApiIntegrationInstallationSummary) => void;
  onPreviewRemove: (instance: ApiIntegrationInstallationSummary) => void;
  onSetupClose: () => void;
  onConnectSetup: (request: IntegrationConnectRequest) => Promise<void>;
  onRemoveClose: () => void;
  onRemoveInstance: () => Promise<boolean>;
  removeTriggerRef: RefObject<HTMLElement | null>;
  setupTriggerRef: RefObject<HTMLElement | null>;
  focusFallbackRef: RefObject<HTMLElement | null>;
  onOpenCustomApi: () => void;
  onUpdateCustomApi: (instance: ApiIntegrationInstallationSummary) => void;
  onReconnectCustomApi: (instance: ApiIntegrationInstallationSummary) => void;
  onCustomApiOpenChange: (open: boolean) => void;
  onCustomApiDraftChange: (patch: Partial<CustomApiFlowState["draft"]>) => void;
  onCustomApiPreview: () => void;
  onCustomApiAuthenticate: () => void;
  onCustomApiInstall: () => void;
  onCustomApiBack: () => void;
  onCustomApiToggleTool: (toolId: string, selected: boolean) => void;
}) {
  return (
    <section
      ref={focusFallbackRef}
      tabIndex={-1}
      className={cn(
        "relative overflow-hidden",
        embedded ? "bg-transparent" : "mt-6 rounded-xl border border-border bg-surface shadow-sm",
      )}
      {...(embedded
        ? { "aria-label": "Connected service accounts" }
        : { "aria-labelledby": "integration-control-center-heading" })}
      aria-busy={loading || callbackBusy}
    >
      {!embedded ? (
        <div className="relative flex flex-col gap-4 border-b border-border/80 bg-brand/5 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-brand/20 bg-brand/10 text-brand shadow-sm">
              <Layers3Icon className="size-5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="integration-control-center-heading"
                  className="text-base font-semibold text-fg"
                >
                  Connected services
                </h2>
                <Badge variant="outline" className="bg-surface text-2xs text-fg transition-none">
                  Multi-account ready
                </Badge>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-fg-muted">
                Add Gmail, Outlook, or OneDrive in a few steps. Every account becomes a separate
                named instance with its own tools, health, permissions, and lifecycle.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-fg-muted transition-none disabled:opacity-100"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh services
          </Button>
        </div>
      ) : null}

      {callbackBusy ? (
        <div
          className="relative flex items-center gap-3 border-b border-brand/20 bg-brand/5 px-5 py-3 text-sm text-fg sm:px-6"
          role="status"
          aria-live="polite"
        >
          <Loader2Icon className="size-4 animate-spin text-brand" />
          <span>Verifying the provider schema and preparing this account's tool namespace…</span>
        </div>
      ) : null}

      <div className={cn("relative", embedded ? "py-3" : "p-4 sm:p-6")}>
        {loading && definitions.length === 0 ? (
          <div className={cn("grid gap-3", !embedded && "md:grid-cols-2 xl:grid-cols-3")}>
            {Array.from({ length: embedded ? 1 : 6 }, (_, index) => (
              <Skeleton key={index} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : loadError ? (
          <div
            className="flex flex-col items-start gap-3 rounded-xl border border-status-failed/40 bg-surface p-4"
            role="alert"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-fg">
              <AlertTriangleIcon className="size-4 text-danger" />
              Services couldn't be loaded
            </div>
            <p className="text-xs leading-5 text-fg-muted">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : (
          <div className={cn("grid gap-3", !embedded && "md:grid-cols-2 xl:grid-cols-3")}>
            {definitions.map((definition) => (
              <DefinitionCard
                key={definition.id}
                client={client}
                workspaceId={workspaceId}
                definition={definition}
                instances={instancesByDefinition.get(definition.id) ?? []}
                connections={connections}
                canManage={canManage}
                canManagePersonalDestination={canManagePersonalDestination}
                canManageWorkspaceDestination={canManageWorkspaceDestination}
                canManageOrganizationDestination={canManageOrganizationDestination}
                refreshRevision={refreshRevision}
                busyKey={busyKey}
                onAdd={() => onOpenSetup(definition)}
                onReconnect={onReconnect}
                onRemove={onPreviewRemove}
              />
            ))}
          </div>
        )}
      </div>

      {showCustomApis ? (
        <CustomApiSection
          instances={customInstances}
          connections={connections}
          canManage={canManage}
          busyKey={busyKey}
          onConnect={onOpenCustomApi}
          onUpdate={onUpdateCustomApi}
          onReconnect={onReconnectCustomApi}
          onRemove={onPreviewRemove}
        />
      ) : null}

      <IntegrationConnectDialog
        open={setupDefinition !== null}
        definition={setupDefinition}
        initialAccountLabel={setupInitialAccountLabel}
        canConnectPersonal={canManage}
        canConnectWorkspace={canManage}
        restoreFocusRef={setupTriggerRef}
        restoreFocusFallbackRef={focusFallbackRef}
        onOpenChange={(open) => !open && onSetupClose()}
        onConnect={onConnectSetup}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && onRemoveClose()}
        title={removeTarget ? `Remove ${removeTarget.instance.displayName}?` : "Remove service?"}
        description={
          removeTarget
            ? `This removes only this named instance${removeTarget.removesDefinition ? " and its now-unused shared definition" : ""}. The authenticated Connection and every sibling account remain intact.`
            : ""
        }
        confirmLabel="Remove instance"
        destructive
        restoreFocusRef={removeTriggerRef}
        restoreFocusFallbackRef={focusFallbackRef}
        onConfirm={onRemoveInstance}
      />

      {showCustomApis ? (
        <CustomApiSetupDialog
          state={customApi}
          connections={connections}
          canManage={canManage}
          onOpenChange={onCustomApiOpenChange}
          onDraftChange={onCustomApiDraftChange}
          onPreview={onCustomApiPreview}
          onAuthenticate={onCustomApiAuthenticate}
          onInstall={onCustomApiInstall}
          onBack={onCustomApiBack}
          onToggleTool={onCustomApiToggleTool}
        />
      ) : null}
    </section>
  );
}

function DefinitionCard({
  client,
  workspaceId,
  definition,
  instances,
  connections,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  refreshRevision,
  busyKey,
  onAdd,
  onReconnect,
  onRemove,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  definition: IntegrationDefinitionSummary;
  instances: ApiIntegrationInstallationSummary[];
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  refreshRevision: number;
  busyKey: string | null;
  onAdd: () => void;
  onReconnect: (instance: ApiIntegrationInstallationSummary) => void;
  onRemove: (instance: ApiIntegrationInstallationSummary) => void;
}) {
  const experience = integrationExperience(definition);
  const connectionById = new Map((connections ?? []).map((entry) => [entry.id, entry]));
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-bg/50 p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-brand/20 bg-brand/5 text-brand shadow-sm">
            <IntegrationExperienceIcon icon={experience.icon} className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-fg">{definition.name}</h3>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">
              {definition.summary}
            </p>
          </div>
        </div>
        <Badge variant="outline" className="bg-surface/50 text-2xs text-fg-subtle">
          {experience.providerName}
        </Badge>
      </div>

      <div className="mt-4 mb-4 space-y-2">
        {instances.map((instance) => {
          const connection = instance.connectionId
            ? connectionById.get(instance.connectionId)
            : undefined;
          const health = !instance.connected
            ? "not_connected"
            : connections === null
              ? "unknown"
              : connection?.status === "active"
                ? "ready"
                : "attention";
          return (
            <div
              key={instance.instanceId}
              className="rounded-lg border border-border bg-surface p-3 shadow-xs"
              data-integration-instance={instance.instanceKey}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {health === "ready" ? (
                      <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
                    ) : health === "unknown" ? (
                      <CloudIcon className="size-3.5 shrink-0 text-fg-subtle" />
                    ) : (
                      <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />
                    )}
                    <p
                      className="truncate text-xs font-semibold text-fg"
                      title={instance.displayName}
                    >
                      {instance.displayName}
                    </p>
                  </div>
                  <p className="mt-1 text-2xs text-fg-subtle">
                    {instance.toolCount} tools ·{" "}
                    {instance.ownership === "personal" ? "Personal" : "Workspace"}
                    {health === "ready"
                      ? " · Ready"
                      : health === "unknown"
                        ? " · Status unavailable"
                        : health === "not_connected"
                          ? " · Account required"
                          : " · Reconnect needed"}
                  </p>
                </div>
                {busyKey === instance.instanceKey ? (
                  <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-brand" />
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {instance.connectionId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!canManage || busyKey !== null}
                    aria-label={`Reconnect ${instance.displayName}`}
                    onClick={() => onReconnect(instance)}
                  >
                    <RefreshCwIcon />
                    Reconnect
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!canManage || busyKey !== null}
                  aria-label={`Remove ${instance.displayName}`}
                  onClick={() => onRemove(instance)}
                >
                  <Trash2Icon />
                  Remove
                </Button>
              </div>
              <IntegrationFacetsPanel
                client={client}
                workspaceId={workspaceId}
                instance={instance}
                facetCount={definition.facets.length}
                canManage={canManage}
                canManagePersonalDestination={canManagePersonalDestination}
                canManageWorkspaceDestination={canManageWorkspaceDestination}
                canManageOrganizationDestination={canManageOrganizationDestination}
                refreshRevision={refreshRevision}
                GoogleDriveDialog={GoogleDriveKnowledgeSourceDialog}
              />
            </div>
          );
        })}
        {instances.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs leading-5 text-fg-muted">
            No account connected yet. Add one to give agents a dedicated, clearly named tool set.
          </p>
        ) : null}
      </div>

      <Button
        type="button"
        variant={instances.length > 0 ? "outline" : "default"}
        size="sm"
        className="mt-auto w-full"
        disabled={busyKey !== null}
        onClick={onAdd}
      >
        <PlusIcon />
        {!canManage
          ? `Review ${definition.name} setup`
          : instances.length > 0
            ? "Add another account"
            : `Connect ${definition.name}`}
      </Button>
      {!canManage ? (
        <p className="mt-2 text-center text-2xs leading-4 text-fg-subtle">
          A workspace administrator must complete the connection.
        </p>
      ) : null}
    </article>
  );
}
