import { ExternalLinkIcon, Loader2Icon, PlugIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  capabilityConnectPlan,
  capabilityKindLabel,
  capabilityReconnectPlan,
  capabilitySourceLabel,
  GENERIC_API_KEY_FIELD,
  type ConnectionHealth,
} from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

export type ConnectAction =
  | { type: "enable"; item: CapabilityCatalogItem }
  | {
      type: "oauth";
      item: CapabilityCatalogItem;
      oauthClient?: {
        clientId: string;
        clientSecret?: string;
        tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
      };
    }
  | { type: "api_key"; item: CapabilityCatalogItem; headers: Record<string, string> }
  // connectionId is the existing row to reuse, or null when the row was deleted
  // (reconnect then mints a fresh connection and re-enables with its ref).
  | { type: "reconnect_oauth"; item: CapabilityCatalogItem; connectionId: string | null }
  | {
      type: "reconnect_api_key";
      item: CapabilityCatalogItem;
      connectionId: string | null;
      headers: Record<string, string>;
    }
  | { type: "disable"; item: CapabilityCatalogItem };

export function CapabilityDetailSheet({
  item,
  health,
  logoSrc,
  open,
  onOpenChange,
  busy,
  errorMessage,
  onAction,
}: {
  item: CapabilityCatalogItem | null;
  health: ConnectionHealth;
  logoSrc: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  errorMessage: string | null;
  onAction: (action: ConnectAction) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 border-border bg-bg p-0 sm:max-w-[30rem]">
        {item ? (
          <DetailBody
            item={item}
            health={health}
            logoSrc={logoSrc}
            busy={busy}
            errorMessage={errorMessage}
            onAction={onAction}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({
  item,
  health,
  logoSrc,
  busy,
  errorMessage,
  onAction,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  errorMessage: string | null;
  onAction: (action: ConnectAction) => void;
}) {
  const plan = useMemo(() => capabilityConnectPlan(item), [item]);
  // API-key reconnect reveals the credential form in place of the button.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => setReconnecting(false), [item.id]);

  const canDisable = item.enabled && item.source !== "built_in" && item.source !== "configured";
  const keyPageUrl = item.installUrl ?? item.homepageUrl;
  // Repair is driven by the installation's OWN connectionRef.kind, not the catalog
  // plan — on catalog/registry drift an enabled item can carry a live connectionRef
  // while its current catalog auth fields read as plain "enable", and gating on the
  // plan would leave "Needs attention" with no Reconnect (the dead end we killed).
  const reconnect = capabilityReconnectPlan(item, health);
  // When the catalog no longer supplies requiredHeaders, fall back to one generic
  // "API key" field so an api-key reconnect still has something to submit.
  const reconnectFields =
    plan.mode === "api_key" && plan.fields.length > 0 ? plan.fields : [GENERIC_API_KEY_FIELD];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <SheetHeader className="gap-3 border-b border-border p-5 pr-12">
        <div className="flex items-start gap-3">
          <CapabilityLogo src={logoSrc} name={item.name} size="lg" />
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-base">{item.name}</SheetTitle>
            <SheetDescription className="mt-0.5 text-xs text-fg-subtle">
              {capabilityKindLabel(item.kind)}
              {item.category && item.category !== "custom" ? ` · ${item.category}` : ""}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {item.stale ? (
          <Notice tone="muted">
            No longer listed in the public registry. Existing installations keep working.
          </Notice>
        ) : null}

        {item.runtime.catalogTrust?.state === "legacy_active" ? (
          <Notice tone="waiting" title="Verification pending">
            This connector was enabled before catalog verification was recorded. Its prior
            connectivity evidence keeps it available during the rolling upgrade; new installs stay
            blocked until a verified catalog refresh backfills it.
          </Notice>
        ) : null}

        {item.description ? (
          <p className="text-sm leading-6 text-fg-muted">{item.description}</p>
        ) : null}

        {item.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 10).map((tag) => (
              <MetaChip key={tag}>{tag}</MetaChip>
            ))}
          </div>
        ) : null}

        <dl className="grid gap-2.5 text-xs">
          <MetaRow label="Source">{capabilitySourceLabel(item.source)}</MetaRow>
          {item.homepageUrl ? (
            <MetaRow label="Homepage">
              <ExternalMetaLink href={item.homepageUrl} />
            </MetaRow>
          ) : null}
          {item.endpointUrl ? (
            <MetaRow label="Endpoint">
              <span className="min-w-0 truncate font-mono text-fg-muted">{item.endpointUrl}</span>
            </MetaRow>
          ) : null}
        </dl>

        {/* Action — flows directly after the content so a sparse item stays a
            compact top-flowing column, with no dead void before a bottom-pinned
            button. The whole body scrolls only when content actually overflows. */}
        <div className="space-y-3 border-t border-border pt-5">
          {errorMessage ? <Notice tone="failed">{errorMessage}</Notice> : null}

          {item.enabled ? (
            <div className="space-y-3">
              <ConnectionStatus health={health} />
              {/* Reconnect is the primary repair action when the connection broke;
                Disable drops to secondary. Healthy items show only Disable. */}
              {reconnect ? (
                reconnect.kind === "oauth" ? (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={busy}
                    onClick={() =>
                      onAction({
                        type: "reconnect_oauth",
                        item,
                        connectionId: reconnect.connectionId,
                      })
                    }
                  >
                    {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                    Reconnect {item.name}
                  </Button>
                ) : reconnecting ? (
                  <CredentialForm
                    fields={reconnectFields}
                    itemName={item.name}
                    keyPageUrl={keyPageUrl}
                    submitLabel="Reconnect"
                    submitIcon={<RefreshCwIcon />}
                    busy={busy}
                    onSubmit={(next) =>
                      onAction({
                        type: "reconnect_api_key",
                        item,
                        connectionId: reconnect.connectionId,
                        headers: next,
                      })
                    }
                  />
                ) : (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={busy}
                    onClick={() => setReconnecting(true)}
                  >
                    <RefreshCwIcon />
                    Reconnect {item.name}
                  </Button>
                )
              ) : null}
              {canDisable ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed"
                  disabled={busy}
                  onClick={() => onAction({ type: "disable", item })}
                >
                  {busy && !reconnect ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
                  Disable
                </Button>
              ) : (
                <p className="text-center text-xs text-fg-subtle">Built in — always available.</p>
              )}
            </div>
          ) : plan.mode === "api_key" ? (
            <CredentialForm
              fields={plan.fields}
              itemName={item.name}
              keyPageUrl={keyPageUrl}
              submitLabel={`Connect ${item.name}`}
              submitIcon={<PlugIcon />}
              busy={busy}
              onSubmit={(next) => onAction({ type: "api_key", item, headers: next })}
            />
          ) : plan.mode === "oauth" ? (
            plan.providerDomain === "slack.com" ? (
              <OAuthClientForm
                itemName={item.name}
                keyPageUrl={keyPageUrl}
                busy={busy}
                onSubmit={(oauthClient) => onAction({ type: "oauth", item, oauthClient })}
              />
            ) : (
              <div className="space-y-2">
                <Button
                  type="button"
                  className="w-full"
                  disabled={busy}
                  onClick={() => onAction({ type: "oauth", item })}
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
                  Connect {item.name}
                </Button>
                <p className="text-center text-xs text-fg-subtle">
                  You'll authorize {item.name} in a new step, then return here.
                </p>
              </div>
            )
          ) : (
            <Button
              type="button"
              className="w-full"
              disabled={busy || (item.kind === "mcp" && !item.runtime.available)}
              title={
                item.kind === "mcp" && !item.runtime.available
                  ? (item.runtime.notes ?? undefined)
                  : undefined
              }
              onClick={() => onAction({ type: "enable", item })}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
              {item.kind === "mcp" || item.kind === "pack" ? "Enable" : "Track"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OAuthClientForm({
  itemName,
  keyPageUrl,
  busy,
  onSubmit,
}: {
  itemName: string;
  keyPageUrl: string | null;
  busy: boolean;
  onSubmit: (oauthClient: {
    clientId: string;
    clientSecret: string;
    tokenEndpointAuthMethod: "client_secret_post";
  }) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const ready = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        onSubmit({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          tokenEndpointAuthMethod: "client_secret_post",
        });
      }}
    >
      <Notice tone="muted">
        {itemName} requires a Slack app OAuth client. Paste the client ID and client secret from
        Slack, then you’ll authorize access in Slack.
      </Notice>
      <div className="space-y-1.5">
        <Label htmlFor="oauth-client-id" className="text-xs text-fg-muted">
          Client ID
        </Label>
        <Input
          id="oauth-client-id"
          type="text"
          autoComplete="off"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="Paste your Slack client ID"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="oauth-client-secret" className="text-xs text-fg-muted">
          Client secret
        </Label>
        <Input
          id="oauth-client-secret"
          type="password"
          autoComplete="off"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder="Paste your Slack client secret"
        />
      </div>
      {keyPageUrl ? (
        <a
          href={keyPageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          Open Slack app settings
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
      <Button type="submit" className="w-full" disabled={busy || !ready}>
        {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
        Connect {itemName}
      </Button>
    </form>
  );
}

// The labeled credential form, shared by first-time connect and reconnect. It
// owns its own header state so it starts empty each time it mounts (a fresh
// sheet, or the reveal on reconnect) — credentials are never prefilled.
function CredentialForm({
  fields,
  itemName,
  keyPageUrl,
  submitLabel,
  submitIcon,
  busy,
  onSubmit,
}: {
  fields: { name: string; label: string }[];
  itemName: string;
  keyPageUrl: string | null;
  submitLabel: string;
  submitIcon: ReactNode;
  busy: boolean;
  onSubmit: (headers: Record<string, string>) => void;
}) {
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const ready = fields.every((field) => headers[field.name]?.trim());

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit(headers);
      }}
    >
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label htmlFor={`cred-${field.name}`} className="text-xs text-fg-muted">
            {field.label}
          </Label>
          <Input
            id={`cred-${field.name}`}
            type="password"
            autoComplete="off"
            value={headers[field.name] ?? ""}
            onChange={(event) =>
              setHeaders((current) => ({ ...current, [field.name]: event.target.value }))
            }
            placeholder={`Paste your ${field.label}`}
          />
        </div>
      ))}
      {keyPageUrl ? (
        <a
          href={keyPageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          Get your {fields[0]?.label ?? "credentials"}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : (
        <p className="text-xs text-fg-subtle">
          Stored encrypted and used only to reach {itemName}.
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !ready}>
        {busy ? <Loader2Icon className="animate-spin" /> : submitIcon}
        {submitLabel}
      </Button>
    </form>
  );
}

function ConnectionStatus({ health }: { health: ConnectionHealth }) {
  // "none" = enabled without a connection (headers-enabled or credential-free);
  // "unverified" = it has a connection but the connections list didn't load, so we
  // can't check it. Both render a neutral "Enabled" — honest, and never a false
  // "Needs attention".
  if (health.state === "none" || health.state === "unverified") {
    return (
      <div className="flex items-center gap-2 text-sm text-status-idle">
        <span className="size-2 rounded-full bg-status-idle" />
        Enabled
      </div>
    );
  }
  const attention = health.state === "attention";
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex items-center gap-2 text-sm",
          attention ? "text-status-waiting" : "text-status-idle",
        )}
      >
        <span
          className={cn("size-2 rounded-full", attention ? "bg-status-waiting" : "bg-status-idle")}
        />
        {attention ? "Needs attention" : "Connected"}
      </div>
      <p className="text-xs text-fg-subtle">
        {attention
          ? "Reconnect to restore access."
          : `Connected to ${health.connection.providerDomain}.`}
      </p>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-fg-muted">{children}</dd>
    </div>
  );
}

function ExternalMetaLink({ href }: { href: string }) {
  let label = href;
  try {
    label = new URL(href).hostname;
  } catch {
    // Non-URL string: show it verbatim.
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-brand hover:underline"
    >
      <span className="truncate">{label}</span>
      <ExternalLinkIcon className="size-3 shrink-0" />
    </a>
  );
}
