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
  capabilitySourceLabel,
} from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";

export type ConnectAction =
  | { type: "enable"; item: CapabilityCatalogItem }
  | { type: "oauth"; item: CapabilityCatalogItem }
  | { type: "api_key"; item: CapabilityCatalogItem; headers: Record<string, string> }
  | { type: "reconnect_oauth"; item: CapabilityCatalogItem; connectionId: string }
  | { type: "reconnect_api_key"; item: CapabilityCatalogItem; connectionId: string; headers: Record<string, string> }
  | { type: "disable"; item: CapabilityCatalogItem };

export function CapabilityDetailSheet({
  item,
  connection,
  logoSrc,
  open,
  onOpenChange,
  busy,
  errorMessage,
  onAction,
}: {
  item: CapabilityCatalogItem | null;
  connection: ConnectionMetadata | null;
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
            connection={connection}
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
  connection,
  logoSrc,
  busy,
  errorMessage,
  onAction,
}: {
  item: CapabilityCatalogItem;
  connection: ConnectionMetadata | null;
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
  // An enabled credentialed item whose connection is no longer active can be
  // repaired in place — otherwise "Needs attention" is a dead end.
  const needsReconnect = item.enabled && plan.mode !== "enable" && connection !== null && connection.status !== "active";

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
          <Notice tone="muted">No longer listed in the public registry. Existing installations keep working.</Notice>
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
            <MetaRow label="Homepage"><ExternalMetaLink href={item.homepageUrl} /></MetaRow>
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
            <ConnectionStatus connection={connection} plan={plan} />
            {/* Reconnect is the primary repair action when the connection broke;
                Disable drops to secondary. Healthy items show only Disable. */}
            {needsReconnect && connection ? (
              plan.mode === "oauth" ? (
                <Button
                  type="button"
                  className="w-full"
                  disabled={busy}
                  onClick={() => onAction({ type: "reconnect_oauth", item, connectionId: connection.id })}
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                  Reconnect {item.name}
                </Button>
              ) : plan.mode === "api_key" && reconnecting ? (
                <CredentialForm
                  fields={plan.fields}
                  itemName={item.name}
                  keyPageUrl={keyPageUrl}
                  submitLabel="Reconnect"
                  submitIcon={<RefreshCwIcon />}
                  busy={busy}
                  onSubmit={(next) => onAction({ type: "reconnect_api_key", item, connectionId: connection.id, headers: next })}
                />
              ) : (
                <Button type="button" className="w-full" disabled={busy} onClick={() => setReconnecting(true)}>
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
                {busy && !needsReconnect ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
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
        ) : (
          <Button
            type="button"
            className="w-full"
            disabled={busy || (item.kind === "mcp" && !item.runtime.available)}
            title={item.kind === "mcp" && !item.runtime.available ? item.runtime.notes ?? undefined : undefined}
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
          <Label htmlFor={`cred-${field.name}`} className="text-xs text-fg-muted">{field.label}</Label>
          <Input
            id={`cred-${field.name}`}
            type="password"
            autoComplete="off"
            value={headers[field.name] ?? ""}
            onChange={(event) => setHeaders((current) => ({ ...current, [field.name]: event.target.value }))}
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
        <p className="text-xs text-fg-subtle">Stored encrypted and used only to reach {itemName}.</p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !ready}>
        {busy ? <Loader2Icon className="animate-spin" /> : submitIcon}
        {submitLabel}
      </Button>
    </form>
  );
}

function ConnectionStatus({
  connection,
  plan,
}: {
  connection: ConnectionMetadata | null;
  plan: ReturnType<typeof capabilityConnectPlan>;
}) {
  // No credentials means no connection to report on — a bare "Enabled" is honest.
  if (plan.mode === "enable") {
    return (
      <div className="flex items-center gap-2 text-sm text-status-idle">
        <span className="size-2 rounded-full bg-status-idle" />
        Enabled
      </div>
    );
  }
  const healthy = !connection || connection.status === "active";
  return (
    <div className="space-y-1">
      <div className={cn("flex items-center gap-2 text-sm", healthy ? "text-status-idle" : "text-status-waiting")}>
        <span className={cn("size-2 rounded-full", healthy ? "bg-status-idle" : "bg-status-waiting")} />
        {healthy ? "Connected" : "Needs attention"}
      </div>
      {connection ? (
        <p className="text-xs text-fg-subtle">
          {healthy ? `Connected to ${connection.providerDomain}.` : "Reconnect to restore access."}
        </p>
      ) : null}
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
