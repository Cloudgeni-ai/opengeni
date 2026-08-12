import {
  AlertTriangleIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  CloudIcon,
  ContactRoundIcon,
  HardDriveIcon,
  Layers3Icon,
  Loader2Icon,
  MailIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { ComponentType, FormEvent, RefObject } from "react";

import { CustomApiSection } from "@/components/capabilities/custom-api-section";
import { CustomApiSetupDialog } from "@/components/capabilities/custom-api-setup-dialog";
import type { CustomApiFlowState } from "@/components/capabilities/custom-api-flow";
import { GoogleDriveKnowledgeSourceDialog } from "@/components/capabilities/google-drive-knowledge-source-dialog";
import { IntegrationFeaturesPanel } from "@/components/capabilities/integration-features-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  ApiIntegrationInstallationSummary,
  ApiIntegrationPresetSummary,
  ConnectionMetadata,
  ConnectionOwnership,
} from "@/types";

export type IntegrationRemoveTarget = {
  instance: ApiIntegrationInstallationSummary;
  removesDefinition: boolean;
};

type PresetVisual = { icon: ComponentType<{ className?: string }> };

const PRESET_VISUALS: Record<string, PresetVisual> = {
  "google-gmail": { icon: MailIcon },
  "google-drive": { icon: HardDriveIcon },
  "microsoft-outlook-mail": { icon: MailIcon },
  "microsoft-outlook-calendar": { icon: CalendarDaysIcon },
  "microsoft-outlook-contacts": { icon: ContactRoundIcon },
  "microsoft-onedrive": { icon: CloudIcon },
};

export function IntegrationControlCenterView({
  client,
  workspaceId,
  presets,
  instancesByPreset,
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
  setupPreset,
  displayName,
  ownership,
  removeTarget,
  customApi,
  embedded,
  showCustomApis,
  onRefresh,
  onOpenSetup,
  onReconnect,
  onPreviewRemove,
  onSetupClose,
  onDisplayNameChange,
  onOwnershipChange,
  onConnectSetup,
  onRemoveClose,
  onRemoveInstance,
  removeTriggerRef,
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
  presets: ApiIntegrationPresetSummary[];
  instancesByPreset: Map<string, ApiIntegrationInstallationSummary[]>;
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
  setupPreset: ApiIntegrationPresetSummary | null;
  displayName: string;
  ownership: ConnectionOwnership;
  removeTarget: IntegrationRemoveTarget | null;
  customApi: CustomApiFlowState;
  embedded: boolean;
  showCustomApis: boolean;
  onRefresh: () => void;
  onOpenSetup: (preset: ApiIntegrationPresetSummary) => void;
  onReconnect: (instance: ApiIntegrationInstallationSummary) => void;
  onPreviewRemove: (instance: ApiIntegrationInstallationSummary) => void;
  onSetupClose: () => void;
  onDisplayNameChange: (value: string) => void;
  onOwnershipChange: (value: ConnectionOwnership) => void;
  onConnectSetup: () => void;
  onRemoveClose: () => void;
  onRemoveInstance: () => Promise<boolean>;
  removeTriggerRef: RefObject<HTMLElement | null>;
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
  function submitSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConnectSetup();
  }

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
        {loading && presets.length === 0 ? (
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
            {presets.map((preset) => (
              <PresetCard
                key={preset.id}
                client={client}
                workspaceId={workspaceId}
                preset={preset}
                instances={instancesByPreset.get(preset.id) ?? []}
                connections={connections}
                canManage={canManage}
                canManagePersonalDestination={canManagePersonalDestination}
                canManageWorkspaceDestination={canManageWorkspaceDestination}
                canManageOrganizationDestination={canManageOrganizationDestination}
                busyKey={busyKey}
                onAdd={() => onOpenSetup(preset)}
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

      <Dialog open={setupPreset !== null} onOpenChange={(open) => !open && onSetupClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {setupPreset ? `Connect ${setupPreset.name}` : "Connect service"}
            </DialogTitle>
            <DialogDescription>
              Name this account so agents and teammates can choose the right one without seeing
              credentials.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={submitSetup}>
            <div className="grid gap-1.5">
              <Label htmlFor="integration-instance-name">Account label</Label>
              <Input
                id="integration-instance-name"
                value={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                placeholder="e.g. Gmail — Finance"
                autoFocus
                maxLength={200}
              />
              <p className="text-2xs text-fg-subtle">
                Labels are editable presentation; the underlying runtime identity remains stable.
              </p>
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-xs font-medium text-fg-muted">
                Who can use this account?
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <OwnershipChoice
                  selected={ownership === "personal"}
                  icon={UserRoundIcon}
                  title="Personal"
                  description="Only you and explicitly delegated runs"
                  onClick={() => onOwnershipChange("personal")}
                />
                <OwnershipChoice
                  selected={ownership === "workspace"}
                  icon={UsersRoundIcon}
                  title="Workspace"
                  description="Available to authorized workspace members"
                  onClick={() => onOwnershipChange("workspace")}
                />
              </div>
            </fieldset>

            <details className="group rounded-lg border border-border bg-bg p-3">
              <summary className="cursor-pointer text-xs font-medium text-fg-muted">
                Permissions requested
              </summary>
              <p className="mt-2 break-words font-mono text-2xs leading-5 text-fg-subtle">
                {setupPreset?.scopes.join(", ")}
              </p>
            </details>

            {!canManage ? (
              <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-fg-muted">
                Ask a workspace administrator to add this account.
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onSetupClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canManage || !displayName.trim()}>
                <ShieldCheckIcon />
                Continue to provider
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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

function PresetCard({
  client,
  workspaceId,
  preset,
  instances,
  connections,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  busyKey,
  onAdd,
  onReconnect,
  onRemove,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  preset: ApiIntegrationPresetSummary;
  instances: ApiIntegrationInstallationSummary[];
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  busyKey: string | null;
  onAdd: () => void;
  onReconnect: (instance: ApiIntegrationInstallationSummary) => void;
  onRemove: (instance: ApiIntegrationInstallationSummary) => void;
}) {
  const Icon = (PRESET_VISUALS[preset.id] ?? { icon: CloudIcon }).icon;
  const connectionById = new Map((connections ?? []).map((entry) => [entry.id, entry]));
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-bg/50 p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-brand/20 bg-brand/5 text-brand shadow-sm">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-fg">{preset.name}</h3>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{preset.summary}</p>
          </div>
        </div>
        <Badge variant="outline" className="bg-surface/50 text-2xs text-fg-subtle">
          {preset.family === "google" ? "Google" : "Microsoft"}
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
              <IntegrationFeaturesPanel
                client={client}
                workspaceId={workspaceId}
                instance={instance}
                featureCount={preset.features.length}
                canManage={canManage}
                canManagePersonalDestination={canManagePersonalDestination}
                canManageWorkspaceDestination={canManageWorkspaceDestination}
                canManageOrganizationDestination={canManageOrganizationDestination}
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
        disabled={!canManage || busyKey !== null}
        onClick={onAdd}
      >
        <PlusIcon />
        {instances.length > 0 ? "Add another account" : `Connect ${preset.name}`}
      </Button>
    </article>
  );
}

function OwnershipChoice({
  selected,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "rounded-xl border p-3 text-left transition-colors",
        selected
          ? "border-brand bg-brand/5 shadow-sm"
          : "border-border bg-surface/50 hover:border-border-strong",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Icon className={cn("size-4", selected ? "text-brand" : "text-fg-subtle")} />
        {title}
      </span>
      <span className="mt-1 block text-2xs leading-4 text-fg-muted">{description}</span>
    </button>
  );
}
