import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  customApiAuthenticationMayBeRequired,
  customApiConnectionRequest,
  customApiFlowReducer,
  customApiInstallValidationError,
  customApiProviderDomain,
  customApiSourceFromDraft,
  initialCustomApiFlowState,
} from "@/components/capabilities/custom-api-flow";
import type { IntegrationRemoveTarget } from "@/components/capabilities/integration-control-center-view";
import { useAppContext } from "@/context";
import { hasAccountPermission } from "@/lib/permissions";
import type {
  ApiIntegrationInstallationSummary,
  ApiIntegrationPresetSummary,
  ConnectionMetadata,
  ConnectionOwnership,
} from "@/types";

const CALLBACK_KEYS = [
  "integration_oauth",
  "presetId",
  "connectionId",
  "providerDomain",
  "ownership",
  "reason",
  "api_integration_preset",
  "api_integration_instance",
  "api_integration_name",
  "api_integration_ownership",
  "api_integration_expected",
] as const;

type PendingIntegrationOAuth = {
  presetId: string;
  instanceKey: string;
  displayName: string;
  ownership: ConnectionOwnership;
  expectedInstanceVersion?: number;
};

const IntegrationControlCenterView = lazy(async () => {
  const module = await import("@/components/capabilities/integration-control-center-view");
  return { default: module.IntegrationControlCenterView };
});

export function apiIntegrationOAuthReturnPath(
  pathname: string,
  currentSearch: string,
  pending: PendingIntegrationOAuth,
): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of CALLBACK_KEYS) params.delete(key);
  params.set("api_integration_preset", pending.presetId);
  params.set("api_integration_instance", pending.instanceKey);
  params.set("api_integration_name", pending.displayName);
  params.set("api_integration_ownership", pending.ownership);
  if (pending.expectedInstanceVersion !== undefined) {
    params.set("api_integration_expected", String(pending.expectedInstanceVersion));
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function pendingApiIntegrationOAuth(search: string):
  | (PendingIntegrationOAuth & {
      outcome: string;
      connectionId: string | null;
      reason: string | null;
    })
  | null {
  const params = new URLSearchParams(search);
  const outcome = params.get("integration_oauth");
  const presetId = params.get("api_integration_preset");
  const instanceKey = params.get("api_integration_instance");
  const displayName = params.get("api_integration_name");
  const ownership = params.get("api_integration_ownership");
  if (
    !outcome ||
    !presetId ||
    !instanceKey ||
    !displayName ||
    (ownership !== "personal" && ownership !== "workspace")
  ) {
    return null;
  }
  const rawExpected = params.get("api_integration_expected");
  const expected = rawExpected ? Number(rawExpected) : undefined;
  return {
    outcome,
    presetId,
    instanceKey,
    displayName,
    ownership,
    connectionId: params.get("connectionId"),
    reason: params.get("reason"),
    ...(expected !== undefined && Number.isInteger(expected) && expected > 0
      ? { expectedInstanceVersion: expected }
      : {}),
  };
}

export function IntegrationControlCenter({
  workspaceId,
  connections,
  canManage,
  onChanged,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const context = useAppContext();
  const client = context.client;
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManagePersonalDestination = Boolean(
    workspaceGrant && context.accessContext?.subjectId === workspaceGrant.subjectId,
  );
  const canManageWorkspaceDestination = canManage;
  const canManageOrganizationDestination = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const [presets, setPresets] = useState<ApiIntegrationPresetSummary[]>([]);
  const [instances, setInstances] = useState<ApiIntegrationInstallationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupPreset, setSetupPreset] = useState<ApiIntegrationPresetSummary | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [ownership, setOwnership] = useState<ConnectionOwnership>("personal");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [callbackBusy, setCallbackBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<IntegrationRemoveTarget | null>(null);
  const [customApi, dispatchCustomApi] = useReducer(
    customApiFlowReducer,
    undefined,
    initialCustomApiFlowState,
  );
  const callbackHandled = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [presetResponse, installedResponse] = await Promise.all([
        client.listApiIntegrationPresets(workspaceId),
        client.listApiIntegrations(workspaceId),
      ]);
      setPresets(presetResponse.presets);
      setInstances(installedResponse.integrations);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (callbackHandled.current) return;
    const pending = pendingApiIntegrationOAuth(window.location.search);
    if (!pending) return;
    callbackHandled.current = true;
    const cleaned = new URL(window.location.href);
    for (const key of CALLBACK_KEYS) cleaned.searchParams.delete(key);
    window.history.replaceState(null, "", `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
    if (pending.outcome !== "success" || !pending.connectionId) {
      toast.error("Connection wasn't completed", {
        description: pending.reason ?? "The provider did not return a usable account.",
      });
      return;
    }
    setCallbackBusy(true);
    setBusyKey(pending.instanceKey);
    void (async () => {
      const source = { kind: "preset" as const, presetId: pending.presetId };
      const preview = await client.previewApiIntegration(workspaceId, {
        source,
        connectionId: pending.connectionId!,
        ownership: pending.ownership,
      });
      await client.installApiIntegration(workspaceId, {
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: pending.connectionId!,
        ownership: pending.ownership,
        instanceKey: pending.instanceKey,
        displayName: pending.displayName,
        ...(pending.expectedInstanceVersion !== undefined
          ? { expectedInstanceVersion: pending.expectedInstanceVersion }
          : {}),
      });
      await Promise.all([load(), onChanged()]);
      toast.success(`${pending.displayName} is ready`, {
        description: `${preview.tools.length} tools are available through this exact account.`,
      });
    })()
      .catch((error) => {
        toast.error("Connected, but couldn't finish setup", {
          description:
            error instanceof Error
              ? error.message
              : "Retry from this service card; the Connection remains safe.",
        });
      })
      .finally(() => {
        setCallbackBusy(false);
        setBusyKey(null);
      });
  }, [client, load, onChanged, workspaceId]);

  const instancesByPreset = useMemo(() => {
    const grouped = new Map<string, ApiIntegrationInstallationSummary[]>();
    for (const instance of instances) {
      if (!instance.presetId) continue;
      const current = grouped.get(instance.presetId) ?? [];
      current.push(instance);
      grouped.set(instance.presetId, current);
    }
    return grouped;
  }, [instances]);

  const customInstances = useMemo(
    () => instances.filter((instance) => instance.presetId === null),
    [instances],
  );

  function openSetup(preset: ApiIntegrationPresetSummary) {
    const count = instancesByPreset.get(preset.id)?.length ?? 0;
    setSetupPreset(preset);
    setDisplayName(count === 0 ? preset.name : `${preset.name} — Account ${count + 1}`);
    setOwnership("personal");
  }

  async function startOAuth(
    preset: ApiIntegrationPresetSummary,
    input: {
      instanceKey: string;
      displayName: string;
      ownership: ConnectionOwnership;
      connectionId?: string;
      expectedInstanceVersion?: number;
    },
  ) {
    setBusyKey(input.instanceKey);
    try {
      const returnPath = apiIntegrationOAuthReturnPath(
        window.location.pathname,
        window.location.search,
        {
          presetId: preset.id,
          instanceKey: input.instanceKey,
          displayName: input.displayName,
          ownership: input.ownership,
          ...(input.expectedInstanceVersion !== undefined
            ? { expectedInstanceVersion: input.expectedInstanceVersion }
            : {}),
        },
      );
      const response = await client.startApiIntegrationOAuth(workspaceId, {
        presetId: preset.id,
        ownership: input.ownership,
        returnPath,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      });
      if (!response.authorizationUrl) throw new Error("The provider did not return a consent URL.");
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setBusyKey(null);
      toast.error("Couldn't start account connection", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function reconnect(instance: ApiIntegrationInstallationSummary) {
    const preset = presets.find((candidate) => candidate.id === instance.presetId);
    if (!preset || !instance.connectionId || instance.ownership === "none") {
      toast.error("This instance cannot be reconnected automatically");
      return;
    }
    await startOAuth(preset, {
      instanceKey: instance.instanceKey,
      displayName: instance.displayName,
      ownership: instance.ownership,
      connectionId: instance.connectionId,
      expectedInstanceVersion: instance.instanceVersion,
    });
  }

  async function previewRemove(instance: ApiIntegrationInstallationSummary) {
    setBusyKey(instance.instanceKey);
    try {
      const preview = await client.previewApiIntegrationUninstall(
        workspaceId,
        instance.capabilityId,
        instance.instanceKey,
      );
      setRemoveTarget({ instance, removesDefinition: preview.removesDefinition });
    } catch (error) {
      toast.error("Couldn't inspect removal impact", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function removeInstance(): Promise<boolean> {
    if (!removeTarget) return false;
    const { instance } = removeTarget;
    setBusyKey(instance.instanceKey);
    try {
      await client.uninstallApiIntegration(
        workspaceId,
        instance.capabilityId,
        instance.instanceKey,
        {
          expectedInstallationVersion: instance.installationVersion,
          expectedInstanceVersion: instance.instanceVersion,
        },
      );
      setRemoveTarget(null);
      await Promise.all([load(), onChanged()]);
      toast.success(`${instance.displayName} removed`, {
        description: "Its Connection was retained and can be reused or disconnected separately.",
      });
      return true;
    } catch (error) {
      toast.error("Couldn't remove this instance", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  function openCustomApi() {
    if (
      customApi.draft.url.trim() ||
      customApi.preview ||
      customApi.error ||
      customApi.editingInstance
    ) {
      dispatchCustomApi({ type: "open" });
      return;
    }
    dispatchCustomApi({ type: "new" });
  }

  function editCustomApi(
    instance: ApiIntegrationInstallationSummary,
    intent: "update" | "reconnect",
  ) {
    const connection = instance.connectionId
      ? ((connections ?? []).find((candidate) => candidate.id === instance.connectionId) ?? null)
      : null;
    dispatchCustomApi({ type: "edit", intent, instance, connection });
  }

  async function previewCustomApi(connection = customApi.connection) {
    let source;
    try {
      source = customApiSourceFromDraft(customApi.draft);
    } catch (error) {
      dispatchCustomApi({
        type: "preview_error",
        message: error instanceof Error ? error.message : String(error),
        authenticationMayBeRequired: false,
      });
      return;
    }
    dispatchCustomApi({ type: "phase", phase: "previewing", error: null });
    try {
      const preview = await client.previewApiIntegration(workspaceId, {
        source,
        ...(connection
          ? { connectionId: connection.id, ownership: customApi.draft.ownership }
          : {}),
      });
      dispatchCustomApi({ type: "preview", preview, connection });
    } catch (error) {
      dispatchCustomApi({
        type: "preview_error",
        message: error instanceof Error ? error.message : String(error),
        authenticationMayBeRequired: customApiAuthenticationMayBeRequired(source, error),
      });
    }
  }

  async function authenticateCustomApi() {
    let connection: ConnectionMetadata;
    dispatchCustomApi({ type: "phase", phase: "creating_connection", error: null });
    try {
      if (customApi.draft.connectionMode === "existing") {
        const selected = (connections ?? []).find(
          (candidate) => candidate.id === customApi.draft.existingConnectionId,
        );
        if (!selected) throw new Error("Choose a compatible existing Connection.");
        connection = selected;
      } else {
        const providerDomain =
          customApi.preview?.providerDomain ?? customApiProviderDomain(customApi.draft);
        connection = await client.createConnection(
          workspaceId,
          customApiConnectionRequest({
            preview: customApi.preview,
            draft: customApi.draft,
            providerDomain,
          }),
        );
        await onChanged();
      }
      dispatchCustomApi({ type: "connection", connection });
      await previewCustomApi(connection);
    } catch (error) {
      dispatchCustomApi({
        type: "phase",
        phase: "auth",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function installCustomApi() {
    const validationError = customApiInstallValidationError(customApi);
    if (validationError) {
      dispatchCustomApi({ type: "phase", phase: "review", error: validationError });
      return;
    }
    const preview = customApi.preview!;
    dispatchCustomApi({ type: "phase", phase: "installing", error: null });
    const editing = customApi.editingInstance;
    try {
      await client.installApiIntegration(workspaceId, {
        source: preview.source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        ...(customApi.connection && preview.auth.kind !== "none"
          ? {
              connectionId: customApi.connection.id,
              ownership: customApi.draft.ownership,
            }
          : {}),
        instanceKey: editing?.instanceKey ?? `custom-${crypto.randomUUID()}`,
        displayName: customApi.draft.displayName.trim(),
        ...(editing ? { expectedInstanceVersion: editing.instanceVersion } : {}),
        allowedTools: customApi.selectedTools,
      });
      await Promise.all([load(), onChanged()]);
      toast.success(`${customApi.draft.displayName.trim()} ${editing ? "updated" : "installed"}`, {
        description: `${customApi.selectedTools.length} tools are available through this exact instance.`,
      });
      dispatchCustomApi({ type: "reset" });
    } catch (error) {
      dispatchCustomApi({
        type: "phase",
        phase: "review",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function customApiBack() {
    if (customApi.phase === "review" && customApi.preview?.auth.kind !== "none") {
      dispatchCustomApi({ type: "phase", phase: "auth", error: null });
      return;
    }
    dispatchCustomApi({ type: "phase", phase: "source", error: null });
  }

  function toggleCustomApiTool(toolId: string, selected: boolean) {
    const next = selected
      ? [...new Set([...customApi.selectedTools, toolId])]
      : customApi.selectedTools.filter((candidate) => candidate !== toolId);
    dispatchCustomApi({ type: "tools", selectedTools: next });
  }

  function connectSetup() {
    if (!setupPreset || !displayName.trim() || !canManage) return;
    const preset = setupPreset;
    setSetupPreset(null);
    void startOAuth(preset, {
      instanceKey: `account-${crypto.randomUUID()}`,
      displayName: displayName.trim(),
      ownership,
    });
  }

  return (
    <Suspense
      fallback={
        <div
          className="mt-6 h-64 rounded-xl border border-border bg-surface"
          aria-label="Loading connected services"
          aria-busy="true"
        />
      }
    >
      <IntegrationControlCenterView
        client={client}
        workspaceId={workspaceId}
        presets={presets}
        instancesByPreset={instancesByPreset}
        customInstances={customInstances}
        connections={connections}
        loading={loading}
        loadError={loadError}
        canManage={canManage}
        canManagePersonalDestination={canManagePersonalDestination}
        canManageWorkspaceDestination={canManageWorkspaceDestination}
        canManageOrganizationDestination={canManageOrganizationDestination}
        busyKey={busyKey}
        callbackBusy={callbackBusy}
        setupPreset={setupPreset}
        displayName={displayName}
        ownership={ownership}
        removeTarget={removeTarget}
        customApi={customApi}
        onRefresh={() => void load()}
        onOpenSetup={openSetup}
        onReconnect={(instance) => void reconnect(instance)}
        onPreviewRemove={(instance) => void previewRemove(instance)}
        onSetupClose={() => setSetupPreset(null)}
        onDisplayNameChange={setDisplayName}
        onOwnershipChange={setOwnership}
        onConnectSetup={connectSetup}
        onRemoveClose={() => setRemoveTarget(null)}
        onRemoveInstance={removeInstance}
        onOpenCustomApi={openCustomApi}
        onUpdateCustomApi={(instance) => editCustomApi(instance, "update")}
        onReconnectCustomApi={(instance) => editCustomApi(instance, "reconnect")}
        onCustomApiOpenChange={(open) => dispatchCustomApi({ type: open ? "open" : "close" })}
        onCustomApiDraftChange={(patch) => dispatchCustomApi({ type: "draft", patch })}
        onCustomApiPreview={() => void previewCustomApi()}
        onCustomApiAuthenticate={() => void authenticateCustomApi()}
        onCustomApiInstall={() => void installCustomApi()}
        onCustomApiBack={customApiBack}
        onCustomApiToggleTool={toggleCustomApiTool}
      />
    </Suspense>
  );
}
