import type { ConnectionMetadata } from "@opengeni/sdk";
import { ChevronDownIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type SVGProps } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
const GATEWAY_ROLE = "vercel_ai_gateway";

/** Vercel mark (simple-icons path) — currentColor so it matches surrounding chrome. */
function VercelMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M24 22.525H0l12-21.05 12 21.05z" />
    </svg>
  );
}

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
  const [open, setOpen] = useState(false);

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
        credentialLabel: "Vercel AI Gateway",
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
      setOpen(false);
      toast.success("Vercel AI Gateway connected");
    } catch (caught) {
      toast.error("Couldn't save Vercel AI Gateway key", {
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
      setOpen(false);
      toast.success("Vercel AI Gateway disconnected");
    } catch (caught) {
      toast.error("Couldn't disconnect Vercel AI Gateway", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  // This is an admin-only opt-in. Non-admins only need to see it when the
  // workspace already connected one; the model picker exposes the usable rail.
  if (!props.canManage && !connected) return null;

  return (
    <details
      className="group rounded-lg border border-border"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
        <VercelMark className="size-3.5 shrink-0 text-fg" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Bring your own Vercel AI Gateway
        </span>
        <span className="text-2xs text-fg-subtle">
          {!loaded ? "…" : connected ? "Connected" : error ? "Unavailable" : "Off"}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
      </summary>

      <div className="grid gap-3 border-t border-border/70 px-3 py-3">
        <p className="text-2xs text-fg-subtle">
          Use models through this workspace's Vercel account. Vercel bills usage directly instead of
          using OpenGeni credits.
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {props.canManage ? (
          <>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="h-9"
                placeholder={connected ? "Replace Vercel AI Gateway key" : "Vercel AI Gateway key"}
                aria-label="Vercel AI Gateway key"
              />
              <Button type="button" disabled={busy || !apiKey.trim()} onClick={save}>
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : connected ? (
                  "Replace"
                ) : (
                  "Connect"
                )}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-2xs text-fg-subtle">
                Stored encrypted. Connecting does not run a model or spend credits.
              </p>
              {connected ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  className="text-destructive hover:text-destructive"
                  onClick={disconnect}
                >
                  <Trash2Icon className="size-3.5" />
                  Disconnect
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-xs text-fg-subtle">
            Workspace admins manage this Vercel AI Gateway connection.
          </p>
        )}
      </div>
    </details>
  );
}
