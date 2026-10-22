import type { ConnectionMetadata } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { Field } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { SecretInput } from "@/components/ui/secret-field";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { possessive } from "./possessive";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";

/* ----------------------------------------------------------------------------
   The ElevenLabs key Eleven Realtime voice models use. The organization can
   connect one key for every workspace; a workspace can connect its own,
   which it uses instead. A workspace key is an API-key connection like the
   other bring-your-own-key providers; the organization key is an
   organization provider key like its gateway keys. Once either is connected,
   the Eleven Realtime models appear in the voice model menu.
   -------------------------------------------------------------------------- */

const ELEVENLABS_DOMAIN = "api.elevenlabs.io";
const ELEVENLABS_ROLE = "elevenlabs";
const ELEVENLABS_MODEL_PREFIX = "workspace-elevenlabs/";

function isElevenLabsConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.subjectId === null &&
    connection.kind === "api_key" &&
    connection.providerDomain === ELEVENLABS_DOMAIN &&
    connection.metadata.credentialRole === ELEVENLABS_ROLE &&
    connection.status !== "revoked"
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof OpenGeniApiError) {
    try {
      const body = JSON.parse(error.body);
      if (typeof body.error?.message === "string") return body.error.message;
    } catch {
      /* Keep the SDK message when the body has no structured error. */
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** One workspace's ElevenLabs key, over its organization's. */
export function ElevenLabsVoiceConnection({
  workspaceId,
  canManage,
  organizationName,
  onConnectionChange,
}: {
  workspaceId: string;
  canManage: boolean;
  /** Names the organization whose key the workspace may use; null outside one. */
  organizationName?: string | null | undefined;
  onConnectionChange?: () => void;
}) {
  const { client } = useAppContext();
  const query = useSharedQuery(
    client,
    ["model-settings", "elevenlabs-connection", workspaceId],
    () => client.listConnections(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  // The voice catalog says whether an ElevenLabs key reaches this workspace.
  const catalog = useSharedQuery(
    client,
    ["model-settings", "realtime-voice-catalog", workspaceId],
    () => client.getWorkspaceRealtimeModelCatalog(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  const connection = (query.data ?? []).find(isElevenLabsConnection) ?? null;
  const organizationKey =
    !connection &&
    (catalog.data?.models ?? []).some(
      (model) => model.id.startsWith(ELEVENLABS_MODEL_PREFIX) && model.available,
    );
  const organization = organizationName ? possessive(organizationName) : "the organization's";

  function refresh() {
    void invalidateModelSettingsQueries(client);
    onConnectionChange?.();
  }

  async function saveKey(apiKey: string) {
    const metadata = { credentialRole: ELEVENLABS_ROLE, credentialLabel: "ElevenLabs" };
    const operationId = crypto.randomUUID();
    try {
      if (connection) {
        await client.updateConnection(workspaceId, connection.id, {
          status: "active",
          credential: { apiKey },
          metadata,
          expectedVersion: connection.version,
          operationId,
        });
      } else {
        await client.createConnection(workspaceId, {
          providerDomain: ELEVENLABS_DOMAIN,
          kind: "api_key",
          subjectId: null,
          credential: { apiKey },
          grantedScopes: [],
          metadata,
          operationId,
        });
      }
    } catch (error) {
      throw new Error(errorMessage(error, "Could not save the ElevenLabs key"), { cause: error });
    }
    refresh();
    toast.success("ElevenLabs connected");
  }

  async function disconnect() {
    if (!connection) return;
    try {
      await client.deleteConnection(workspaceId, connection.id);
    } catch (error) {
      throw new Error(errorMessage(error, "Could not disconnect ElevenLabs"), { cause: error });
    }
    refresh();
  }

  const description = query.error
    ? query.error.message
    : connection
      ? connection.status === "active"
        ? "Connected with this workspace's own key. Eleven Realtime voices are billed to its ElevenLabs account."
        : "This key needs to be replaced before Eleven Realtime voices work again."
      : organizationKey
        ? `Uses ${organization} ElevenLabs key. Connect this workspace's own key to bill another ElevenLabs account.`
        : "Connect an ElevenLabs API key to talk with Eleven Realtime voices.";

  return (
    <ElevenLabsKeyRow
      description={description}
      canManage={canManage}
      loading={query.loading}
      connected={Boolean(connection)}
      connectLabel={organizationKey ? "Use own key" : "Connect"}
      dialogTitle={
        connection
          ? "Replace the ElevenLabs key"
          : organizationKey
            ? "Use this workspace's own ElevenLabs key"
            : "Connect ElevenLabs"
      }
      dialogDescription={
        organizationKey
          ? `Voice sessions in this workspace started after this use this key instead of ${organization}.`
          : "Voice sessions started after this use the new key."
      }
      disconnectConsequences={[
        organizationName
          ? `New voice sessions use ${organization} ElevenLabs key if it has one; otherwise Eleven Realtime voices stop working.`
          : "Eleven Realtime voices stop working for new voice sessions.",
        "The saved API key is removed from Opengeni. You can reconnect with a valid key.",
      ]}
      onSaveKey={saveKey}
      onDisconnect={disconnect}
    />
  );
}

/** The organization's ElevenLabs key, which every workspace without its own uses. */
export function OrganizationElevenLabsVoiceConnection({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const { client } = useAppContext();
  const query = useSharedQuery(
    client,
    ["model-settings", "organization-provider", organizationId, "elevenlabs", "connection"],
    () => client.getOrganizationModelProviderConnection(organizationId, "elevenlabs"),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  const connection = query.data ?? null;
  const active = connection?.status === "active";

  async function saveKey(apiKey: string) {
    try {
      await client.upsertOrganizationModelProviderConnection(organizationId, "elevenlabs", {
        operationId: crypto.randomUUID(),
        expectedVersion: connection?.version ?? 0,
        apiKey,
      });
    } catch (error) {
      throw new Error(errorMessage(error, "Could not save the ElevenLabs key"), { cause: error });
    }
    await invalidateModelSettingsQueries(client);
    toast.success(`ElevenLabs connected for ${organizationName}`);
  }

  async function disconnect() {
    if (!connection || !active) return;
    try {
      await client.revokeOrganizationModelProviderConnection(organizationId, "elevenlabs", {
        operationId: crypto.randomUUID(),
        expectedVersion: connection.version,
      });
    } catch (error) {
      throw new Error(errorMessage(error, "Could not disconnect ElevenLabs"), { cause: error });
    }
    await invalidateModelSettingsQueries(client);
  }

  const description = query.error
    ? query.error.message
    : active
      ? "Connected for every workspace. Eleven Realtime voices are billed to this ElevenLabs account unless a workspace connects its own key."
      : `Connect an ElevenLabs API key once to talk with Eleven Realtime voices in every workspace in ${organizationName}.`;

  return (
    <ElevenLabsKeyRow
      description={description}
      canManage
      loading={query.loading}
      connected={active}
      connectLabel="Connect"
      dialogTitle={active ? "Replace the ElevenLabs key" : "Connect ElevenLabs"}
      dialogDescription="Voice sessions started after this use the new key, in every workspace without its own."
      disconnectConsequences={[
        "Eleven Realtime voices stop working in workspaces without their own ElevenLabs key.",
        "The saved API key is removed from Opengeni. You can reconnect with a valid key.",
      ]}
      onSaveKey={saveKey}
      onDisconnect={disconnect}
    />
  );
}

function ElevenLabsKeyRow({
  description,
  canManage,
  loading,
  connected,
  connectLabel,
  dialogTitle,
  dialogDescription,
  disconnectConsequences,
  onSaveKey,
  onDisconnect,
}: {
  description: string;
  canManage: boolean;
  loading: boolean;
  connected: boolean;
  connectLabel: string;
  dialogTitle: string;
  dialogDescription: string;
  disconnectConsequences: string[];
  onSaveKey: (apiKey: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [key, setKey] = useState("");

  async function saveKey() {
    const apiKey = key.trim();
    if (!apiKey) return false;
    await onSaveKey(apiKey);
  }

  return (
    <SettingRowGroup>
      <SettingRow
        label="ElevenLabs"
        description={description}
        control={
          canManage ? (
            <div className="flex items-center gap-2">
              <RowButton onClick={() => setKeyOpen(true)} disabled={loading}>
                {connected ? "Replace key" : connectLabel}
              </RowButton>
              {connected ? (
                <MoreMenu label="More actions for ElevenLabs" quiet>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDisconnectOpen(true)}>
                    <UnplugIcon />
                    Disconnect
                  </DropdownMenuItem>
                </MoreMenu>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <FormDialog
        open={keyOpen}
        onOpenChange={(open) => {
          setKeyOpen(open);
          if (!open) setKey("");
        }}
        size="sm"
        title={dialogTitle}
        description={dialogDescription}
        submitLabel={connected ? "Replace key" : "Connect"}
        pendingLabel="Saving…"
        submitDisabled={!key.trim()}
        onSubmit={saveKey}
        onSubmitted={() => {
          setKeyOpen(false);
          setKey("");
        }}
      >
        <Field
          label="API key"
          hint="Create one in your ElevenLabs account settings. It's stored encrypted and never shown again."
        >
          <SecretInput
            value={key}
            autoComplete="off"
            aria-label="ElevenLabs API key"
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
      </FormDialog>
      <DestructiveConfirm
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect ElevenLabs?"
        consequences={disconnectConsequences}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={onDisconnect}
      />
    </SettingRowGroup>
  );
}
