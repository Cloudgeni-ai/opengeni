import { directModelConnectionSpec } from "@opengeni/contracts";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { DirectModelProviderForm } from "./direct-model-provider-connection";
import { applyConnectedModelToNewSessionDraft } from "@/lib/model-access-onboarding";

export function DirectModelProviderConnections({
  workspaceId,
  canManage,
  onConnectionChange,
}: {
  workspaceId: string;
  canManage: boolean;
  onConnectionChange?: () => void;
}) {
  const { client } = useAppContext();
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    client
      .listConnections(workspaceId)
      .then((rows) => {
        if (!cancelled) {
          setConnections(rows.filter((row) => directModelConnectionSpec(row)));
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Could not load provider connections");
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, revision]);
  function refresh() {
    setRevision((value) => value + 1);
    onConnectionChange?.();
  }
  async function disconnect(connection: ConnectionMetadata) {
    setBusy(true);
    try {
      await client.deleteConnection(workspaceId, connection.id);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="divide-y divide-border">
      {error ? (
        <p role="alert" className="py-3 text-sm text-fg-muted">
          {error}
        </p>
      ) : null}
      {connections.map((connection) => (
        <div key={connection.id} className="flex items-center justify-between gap-3 py-3 text-sm">
          <span>
            {connection.metadata.credentialLabel as string} ·{" "}
            {directModelConnectionSpec(connection)?.model}
          </span>
          {canManage ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void disconnect(connection)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ))}
      {canManage
        ? (["openai", "azure_openai"] as const).map((provider) => (
            <details key={provider} className="py-3">
              <summary className="cursor-pointer text-sm font-medium">
                Connect {provider === "openai" ? "OpenAI" : "Azure OpenAI"}
              </summary>
              <div className="pb-2 pt-4">
                <DirectModelProviderForm
                  client={client}
                  workspaceId={workspaceId}
                  provider={provider}
                  onConnected={async (modelId) => {
                    refresh();
                    try {
                      if (
                        !(await applyConnectedModelToNewSessionDraft(
                          client,
                          workspaceId,
                          provider,
                          modelId,
                        ))
                      )
                        throw new Error("Model is not selectable yet");
                    } catch {
                      throw new Error(
                        "Your connection was saved. Choose its model in the chat’s model menu when you’re ready.",
                      );
                    }
                    toast.success("Ready for your next chat");
                  }}
                />
              </div>
            </details>
          ))
        : null}
    </div>
  );
}
