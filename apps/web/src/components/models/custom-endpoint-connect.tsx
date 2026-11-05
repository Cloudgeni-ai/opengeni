import { directModelConnectionSpec, type CompatibleModelApi } from "@opengeni/contracts";
import type { ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ProviderTile } from "@opengeni/react/app/components/models/provider-mark";
import { ModelsFormPage } from "@opengeni/react/app/components/models/models-ui";
import { applyConnectedModelToNewSessionDraft } from "@opengeni/react/app/lib/model-access-onboarding";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { ListRow } from "@opengeni/react/ui/list-row";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SelectMenu } from "@opengeni/react/ui/select-menu";

import {
  DIRECT_MODEL_PROVIDER_LABELS,
  connectDirectModelProvider,
  parseDirectModelSettings,
  useConnectOperation,
  type DirectModelField,
} from "@/components/direct-model-provider-connection";

/* ----------------------------------------------------------------------------
   A workspace's own model keys: custom OpenAI-compatible endpoints, and
   OpenAI or Azure OpenAI keys connected during onboarding or over the API.

   A custom endpoint is connected from Connect provider like every other
   provider. It always belongs to one workspace (its key is sent to an
   address the workspace chose), so its step asks which workspace instead of
   offering the organization's "Available in". Connected ones are rows in the
   workspace's provider list, next to its other keys.
   -------------------------------------------------------------------------- */

/** The workspace's own model key connections, metadata only. */
export function useDirectModelConnections(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  enabled: boolean,
) {
  const query = useSharedQuery(
    client,
    ["model-settings", "direct-connections", workspaceId],
    () => client.listConnections(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS, enabled },
  );
  return {
    connections: (query.data ?? []).filter((row) => directModelConnectionSpec(row)),
    loading: enabled && query.data === undefined && !query.error,
    error: query.error,
  };
}

/** How a workspace's own key is named in its row: "Together", "OpenAI API". */
function directConnectionTitle(connection: ConnectionMetadata): string {
  const spec = directModelConnectionSpec(connection);
  if (spec?.provider === "openai") return "OpenAI API";
  if (spec?.provider === "azure_openai") return DIRECT_MODEL_PROVIDER_LABELS.azure_openai;
  const label = connection.metadata.credentialLabel;
  return typeof label === "string" && label ? label : connection.providerDomain;
}

/**
 * One row per workspace key: its provider, whose it is, and the model it
 * serves. Disconnecting asks first; replacing a key or model is connecting
 * again, since each connection serves exactly one model.
 */
export function DirectModelConnectionRows({
  client,
  workspaceId,
  connections,
  scope,
  canManage,
  onChange,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  connections: readonly ConnectionMetadata[];
  /** Who the key is for: "Design preview only". */
  scope: string;
  canManage: boolean;
  onChange: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState<ConnectionMetadata | null>(null);
  return (
    <>
      {connections.map((connection) => {
        const spec = directModelConnectionSpec(connection)!;
        const title = directConnectionTitle(connection);
        return (
          <ListRow
            key={connection.id}
            leading={<ProviderTile provider={spec.provider} size="lg" />}
            title={title}
            meta={[scope, "API key", spec.model]}
            menu={
              canManage ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDisconnecting(connection)}
                >
                  Disconnect
                </DropdownMenuItem>
              ) : undefined
            }
          />
        );
      })}
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        title={disconnecting ? `Disconnect ${directConnectionTitle(disconnecting)}?` : ""}
        description="Its model leaves this workspace’s model menu and its key is deleted. To use it again, connect it again."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          if (!disconnecting) return;
          try {
            await client.deleteConnection(workspaceId, disconnecting.id);
          } catch (error) {
            toast.error(userErrorText(error, "Could not disconnect"));
            return false;
          }
          await invalidateModelSettingsQueries(client);
          onChange();
        }}
      />
    </>
  );
}

export type EndpointWorkspace = { id: string; name: string; personal: boolean };

/**
 * Connect provider > Custom endpoint: any API that follows OpenAI's Chat
 * Completions or Responses format. `workspaces` are where the viewer may
 * connect one; with more than one, the step asks which.
 */
export function CustomEndpointConnectPage({
  client,
  workspaces,
  initialWorkspaceId,
  note,
  onClose,
  onConnected,
}: {
  client: OpenGeniBrowserClient;
  workspaces: readonly EndpointWorkspace[];
  /** The workspace the step was opened from, chosen to start with. */
  initialWorkspaceId?: string | undefined;
  /** What connecting it here means, above the fields (one workspace, no choice). */
  note?: ReactNode;
  onClose: () => void;
  /** Opens the workspace the endpoint was connected in. */
  onConnected: (workspaceId: string) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.find((each) => each.id === initialWorkspaceId)?.id ??
      (workspaces.length === 1 ? workspaces[0]!.id : ""),
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [api, setApi] = useState<CompatibleModelApi>("chat");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Partial<Record<DirectModelField, string>>>({});
  const operation = useConnectOperation();
  const clearError = (field: DirectModelField) =>
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  const choosing = workspaces.length > 1;
  return (
    <ModelsFormPage
      connectStep
      headerAside={<ProviderTile provider="openai_compatible" />}
      title="Connect a custom endpoint"
      description="Any API that follows OpenAI’s Chat Completions or Responses format, from a provider or your own server. Usage is billed by that provider."
      onClose={onClose}
      submitLabel="Connect endpoint"
      pendingLabel="Checking connection…"
      submitDisabled={!workspaceId || !baseUrl.trim() || !apiKey.trim() || !model.trim()}
      disabledReason={
        workspaces.length === 0
          ? "Only a workspace’s admins can connect a custom endpoint to it."
          : undefined
      }
      footerStart="We check it with one short test message before saving."
      onSubmit={async () => {
        const settings = parseDirectModelSettings(
          {
            provider: "openai_compatible",
            model,
            baseUrl,
            api,
            ...(name.trim() ? { label: name } : {}),
          },
          "openai_compatible",
        );
        if (!settings.ok) {
          setErrors(settings.errors);
          return false;
        }
        setErrors({});
        const key = apiKey.trim();
        const modelId = await connectDirectModelProvider(
          client,
          workspaceId,
          settings.config,
          key,
          operation.idFor(JSON.stringify([workspaceId, key, settings.config])),
        );
        operation.reset();
        await invalidateModelSettingsQueries(client);
        const selected = await applyConnectedModelToNewSessionDraft(
          client,
          workspaceId,
          "openai_compatible",
          modelId,
        ).catch(() => null);
        toast.success("Custom endpoint connected", {
          description: selected
            ? `${selected.label} is selected for your next chat.`
            : "Choose its model in the chat’s model menu when you’re ready.",
        });
      }}
      onSubmitted={() => onConnected(workspaceId)}
    >
      <FieldStack>
        {note}
        {choosing ? (
          <Field
            label="Workspace"
            hint="Only this workspace can use it. To use it in another workspace too, connect it there."
            required
          >
            <SelectMenu
              size="md"
              aria-label="Workspace"
              placeholder="Choose a workspace"
              options={workspaces.map((each) => ({
                value: each.id,
                label: each.personal ? "Your Personal workspace" : each.name,
              }))}
              value={workspaceId}
              onValueChange={setWorkspaceId}
              className="w-full"
            />
          </Field>
        ) : null}
        <Field
          label="Base URL"
          hint="The address your provider’s docs give for its OpenAI-compatible API, usually ending in /v1."
          error={errors.baseUrl}
          required
        >
          <TextInput
            mono
            type="url"
            inputMode="url"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              clearError("baseUrl");
            }}
          />
        </Field>
        <Field
          label="API key"
          hint="It is stored encrypted and only sent to this address."
          required
        >
          <TextInput
            mono
            type="password"
            value={apiKey}
            placeholder="Paste your API key"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        <Field
          label="Model ID"
          hint="Exactly as your provider lists it under /models. To use more models, connect each one."
          error={errors.model}
          required
        >
          <TextInput
            mono
            value={model}
            placeholder="provider/model-name"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setModel(event.target.value);
              clearError("model");
            }}
          />
        </Field>
        <Field
          label="API format"
          hint="Most compatible APIs use Chat Completions. Choose Responses only if your provider recommends it."
          group
        >
          <SegmentedControl
            className="self-start"
            value={api}
            options={[
              { value: "chat", label: "Chat Completions" },
              { value: "responses", label: "Responses" },
            ]}
            onValueChange={(value) => setApi(value as CompatibleModelApi)}
          />
        </Field>
        <Field
          label="Name"
          hint="How it is named in Opengeni, like your provider’s name. Without one, its address is used."
          error={errors.label}
          optional
        >
          <TextInput
            value={name}
            placeholder="Your provider’s name"
            maxLength={60}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              clearError("label");
            }}
          />
        </Field>
      </FieldStack>
    </ModelsFormPage>
  );
}
