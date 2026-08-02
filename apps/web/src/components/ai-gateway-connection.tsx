import type { ConnectionMetadata } from "@opengeni/sdk";
import { KeyRoundIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
const GATEWAY_ROLE = "vercel_ai_gateway";

function isGatewayConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.subjectId === null &&
    connection.providerDomain === GATEWAY_DOMAIN &&
    connection.kind === "api_key" &&
    connection.metadata.credentialRole === GATEWAY_ROLE
  );
}

export function AiGatewayConnectionCard(props: { workspaceId: string; canManage: boolean }) {
  const client = useAppContext().client;
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const connection = useMemo(() => {
    const gatewayConnections = connections.filter(isGatewayConnection);
    return (
      gatewayConnections.find((candidate) => candidate.status === "active") ??
      gatewayConnections[0] ??
      null
    );
  }, [connections]);
  const connected = connection?.status === "active";

  const refresh = useCallback(async () => {
    try {
      setConnections(await client.listConnections(props.workspaceId));
      setError(null);
    } catch (caught) {
      setConnections([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoaded(true);
    }
  }, [client, props.workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    const value = apiKey.trim();
    if (!value) return;
    setBusy(true);
    try {
      const metadata = {
        credentialRole: GATEWAY_ROLE,
        credentialLabel: "Your Gateway",
      };
      const saved =
        connection && connection.status !== "revoked"
          ? await client.updateConnection(props.workspaceId, connection.id, {
              status: "active",
              credential: { apiKey: value },
              metadata,
            })
          : await client.createConnection(props.workspaceId, {
              providerDomain: GATEWAY_DOMAIN,
              kind: "api_key",
              subjectId: null,
              credential: { apiKey: value },
              grantedScopes: [],
              metadata,
            });
      setConnections((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setApiKey("");
      toast.success("Gateway connected");
    } catch (caught) {
      toast.error("Couldn't save Gateway key", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection) return;
    setBusy(true);
    try {
      const revoked = await client.deleteConnection(props.workspaceId, connection.id);
      setConnections((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      toast.success("Gateway disconnected");
    } catch (caught) {
      toast.error("Couldn't disconnect Gateway", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="workspace-gateway-heading"
      className="rounded-lg border border-border"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <KeyRoundIcon className="size-3.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <h2 id="workspace-gateway-heading" className="text-sm font-medium">
            Your Gateway
          </h2>
          <p className="text-2xs text-fg-subtle">Use the workspace's own AI Gateway billing.</p>
        </div>
        <span className="text-2xs text-fg-subtle">
          {!loaded ? "…" : connected ? "Connected" : "Not connected"}
        </span>
      </div>

      <div className="grid gap-3 px-3 py-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {props.canManage ? (
          <>
            <div className="flex gap-2">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={connected ? "Replace AI Gateway key" : "AI Gateway key"}
                aria-label="AI Gateway key"
              />
              <Button type="button" size="sm" disabled={busy || !apiKey.trim()} onClick={save}>
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : connected ? (
                  "Replace"
                ) : (
                  "Connect"
                )}
              </Button>
              {connected ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label="Disconnect Gateway"
                  onClick={disconnect}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              ) : null}
            </div>
            <p className="text-2xs text-fg-subtle">
              Stored encrypted. Saving never runs a model or spends Gateway credits.
            </p>
          </>
        ) : (
          <p className="text-xs text-fg-subtle">
            Workspace admins can connect or replace this key.
          </p>
        )}
      </div>
    </section>
  );
}
