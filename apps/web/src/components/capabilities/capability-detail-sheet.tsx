import { ExternalLinkIcon, Loader2Icon, PlugIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

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
  curatedSkillProvenance,
  GENERIC_API_KEY_FIELD,
  type ConnectionHealth,
} from "@/lib/capabilities";
import { focusCapabilitySuccessor } from "@/lib/capability-focus";
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
  restoreFocusRef,
  restoreFocusFallbackRef,
  busy,
  errorMessage,
  onAction,
}: {
  item: CapabilityCatalogItem | null;
  health: ConnectionHealth;
  logoSrc: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>;
  busy: boolean;
  errorMessage: string | null;
  onAction: (action: ConnectAction) => void;
}) {
  const localRestoreFocusRef = useRef<HTMLElement | null>(null);
  const focusRef = restoreFocusRef ?? localRestoreFocusRef;
  const focusTargetIdRef = useRef<string | null>(null);

  // The selected item is cleared at the same time the controlled sheet closes.
  // Retain its identity independently so the close autofocus hook can find the
  // newly rendered Enabled control after a successful enable refresh.
  useLayoutEffect(() => {
    if (item) focusTargetIdRef.current = item.id;
  }, [item]);

  // Capture before Radix's focus scope moves focus into the sheet. Routes pass
  // a synchronously captured opener for click/keyboard activation; this local
  // fallback keeps the controlled sheet safe for other callers too.
  useLayoutEffect(() => {
    if (!open) return;
    if (focusRef.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      focusRef.current = active;
    }
  }, [focusRef, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 border-border bg-bg p-0 sm:max-w-[30rem]"
        onCloseAutoFocus={(event) => {
          const opener = focusRef.current;
          focusRef.current = null;
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
            return;
          }

          const restore = () =>
            focusCapabilitySuccessor(
              focusTargetIdRef.current,
              restoreFocusFallbackRef?.current ?? null,
            );
          event.preventDefault();
          // Refresh + close normally commit the Enabled control before Radix
          // invokes this hook. One frame covers the rare slower commit without
          // allowing Radix to restore focus to document.body in the meantime.
          if (!restore()) {
            if (typeof window.requestAnimationFrame === "function") {
              window.requestAnimationFrame(restore);
            } else {
              window.setTimeout(restore, 0);
            }
          }
        }}
      >
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

        <CuratedSkillProvenanceSection item={item} />

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
                  className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
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
              Enable
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CuratedSkillProvenanceSection({ item }: { item: CapabilityCatalogItem }) {
  const metadata = curatedSkillProvenance(item);
  if (!metadata) return null;

  return (
    <section
      aria-labelledby="curated-skill-provenance-heading"
      className="space-y-2.5 border-t border-border pt-5"
    >
      <div>
        <h3 id="curated-skill-provenance-heading" className="text-sm font-medium text-fg">
          Curated skill provenance
        </h3>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">
          Immutable reviewed metadata for the exact artifact selected by this workspace.
        </p>
      </div>
      <dl className="grid gap-2.5 text-xs">
        <MetaRow label="Status">
          <span className="font-medium text-fg">
            {metadata.status === "enabled" ? "Enabled" : "Not enabled"}
          </span>
        </MetaRow>
        <MetaRow label="Effective selection">
          <span className="min-w-0 break-words text-right">
            {humanizeSelection(metadata.effectiveSelection)}
          </span>
        </MetaRow>
        <MetaRow label="Version (immutable)">
          <span className="font-mono text-fg-muted">{metadata.version ?? "Unavailable"}</span>
        </MetaRow>
        <MetaRow label="Artifact SHA-256">
          <span className="min-w-0 break-all font-mono text-fg-muted">
            {metadata.contentSha256 ?? "Unavailable"}
          </span>
        </MetaRow>
        <MetaRow label="Source commit">
          <span className="min-w-0 break-all font-mono text-fg-muted">
            {metadata.sourceCommit ?? "Unavailable"}
          </span>
        </MetaRow>
        <MetaRow label="Provenance">
          <span className="min-w-0 break-words text-right text-fg-muted">
            {metadata.provenance ?? "Unavailable"}
          </span>
        </MetaRow>
        {metadata.sourceUrl ? (
          <MetaRow label="Source">
            <ExternalMetaLink href={metadata.sourceUrl} />
          </MetaRow>
        ) : null}
        {metadata.documentationUrl ? (
          <MetaRow label="Documentation">
            <ExternalMetaLink href={metadata.documentationUrl} />
          </MetaRow>
        ) : null}
        {metadata.license ? <MetaRow label="License">{metadata.license}</MetaRow> : null}
      </dl>
    </section>
  );
}

function humanizeSelection(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown";
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
