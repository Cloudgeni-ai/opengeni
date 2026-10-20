import type { ConnectionMetadata } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { SecretInput } from "@/components/ui/secret-field";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@/lib/shared-query";

/* ----------------------------------------------------------------------------
   The workspace's ElevenLabs key, used by Eleven Realtime voice models. The
   key is a workspace API-key connection like the other bring-your-own-key
   providers; once connected, the Eleven Realtime models appear in the voice
   model menu.
   -------------------------------------------------------------------------- */

const ELEVENLABS_DOMAIN = "api.elevenlabs.io";
const ELEVENLABS_ROLE = "elevenlabs";

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

export function ElevenLabsVoiceConnection({
  workspaceId,
  canManage,
  onConnectionChange,
}: {
  workspaceId: string;
  canManage: boolean;
  onConnectionChange?: () => void;
}) {
  const { client } = useAppContext();
  const query = useSharedQuery(
    client,
    ["model-settings", "elevenlabs-connection", workspaceId],
    () => client.listConnections(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  const connection = (query.data ?? []).find(isElevenLabsConnection) ?? null;
  const [keyOpen, setKeyOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [key, setKey] = useState("");

  function refresh() {
    void invalidateModelSettingsQueries(client);
    onConnectionChange?.();
  }

  async function saveKey() {
    const apiKey = key.trim();
    if (!apiKey) return false;
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
        ? "Connected. Eleven Realtime voices are billed to your ElevenLabs account."
        : "This key needs to be replaced before Eleven Realtime voices work again."
      : "Connect an ElevenLabs API key to talk with Eleven Realtime voices.";

  return (
    <SettingRowGroup>
      <SettingRow
        label="ElevenLabs"
        description={description}
        control={
          canManage ? (
            <div className="flex items-center gap-2">
              <RowButton onClick={() => setKeyOpen(true)} disabled={query.loading}>
                {connection ? "Replace key" : "Connect"}
              </RowButton>
              {connection ? (
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
        title={connection ? "Replace the ElevenLabs key" : "Connect ElevenLabs"}
        description="Voice sessions started after this use the new key."
        submitLabel={connection ? "Replace key" : "Connect"}
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
        consequences={[
          "Eleven Realtime voices stop working for new voice sessions.",
          "The saved API key is removed from Opengeni. You can reconnect with a valid key.",
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={disconnect}
      />
    </SettingRowGroup>
  );
}
