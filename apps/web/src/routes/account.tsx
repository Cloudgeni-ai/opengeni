// Account: identity, billing balance + usage (from /v1/billing/usage), plan
// entitlements (from /v1/billing/entitlements), and workspace API keys with
// the grouped delegable-permission picker.
import { useBillingUsage } from "@opengeni/react";
import {
  ActivityIcon,
  CopyIcon,
  GaugeIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { PermissionGroupPicker } from "@/components/permission-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";
import { entitlementEntries, formatMoneyMicros, formatTimestamp, validTopupAmount } from "@/lib/format";
import {
  apiKeyPermissionGroups,
  defaultApiKeyPermissions,
  delegableApiKeyPermissions,
  hasAccountPermission,
  hasWorkspacePermission,
} from "@/lib/permissions";
import type { ApiKey, BillingEntitlementsResponse, BillingSummary, UsageEvent } from "@/types";

export function AccountRoute({ workspaceId, checkout }: { workspaceId: string; checkout?: "success" | "cancelled" }) {
  const context = useAppContext();
  const client = context.client;
  const activeWorkspace = context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingError, setBillingError] = useState<Error | null>(null);
  const [entitlements, setEntitlements] = useState<BillingEntitlementsResponse | null>(null);
  const [entitlementsError, setEntitlementsError] = useState<Error | null>(null);
  const [apiKeyName, setApiKeyName] = useState("Default API key");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(() => new Set(defaultApiKeyPermissions));
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [busy, setBusy] = useState(false);
  const canManageApiKeys = hasWorkspacePermission(context.accessContext, workspaceId, "api_keys:manage");
  const canManageBilling = hasAccountPermission(context.accessContext, accountId, "billing:manage");
  const canReadBilling = canManageBilling || hasAccountPermission(context.accessContext, accountId, "billing:read");
  const workspaceGrant = context.accessContext.workspaceGrants.find((grant) => grant.workspaceId === workspaceId) ?? null;
  const delegablePermissions = delegableApiKeyPermissions(workspaceGrant?.permissions ?? []);
  const requestedPermissions = [...selectedPermissions].filter((permission) => delegablePermissions.has(permission));
  const usage = useBillingUsage({
    ...(accountId ? { accountId } : {}),
    workspaceId,
    enabled: canReadBilling && Boolean(accountId),
  });

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refresh();
  }, [workspaceId, accountId]);

  // Confirm the Stripe checkout outcome the /billing return redirect forwarded
  // here. Credits post via the asynchronous webhook, so success is phrased as
  // "shortly" rather than implying the balance already reflects the top-up.
  useEffect(() => {
    if (checkout === "success") {
      toast.success("Payment received", { description: "Your credits will appear shortly." });
    } else if (checkout === "cancelled") {
      toast("Checkout cancelled", { description: "No charge was made." });
    }
  }, [checkout]);

  // Each loader records its own failure: a failed request must render as an
  // error with retry, never as "No API keys." or a quietly absent balance.
  async function refreshApiKeys() {
    if (!canManageApiKeys) {
      setApiKeys([]);
      setApiKeysError(null);
      return;
    }
    try {
      setApiKeys(await client.listApiKeys(workspaceId));
      setApiKeysError(null);
    } catch (error) {
      setApiKeys([]);
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function refreshBilling() {
    if (!accountId || !canReadBilling) {
      setBilling(null);
      setBillingError(null);
      return;
    }
    try {
      setBilling(await client.getBilling({ accountId }));
      setBillingError(null);
    } catch (error) {
      setBilling(null);
      setBillingError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function refreshEntitlements() {
    if (!accountId || !canReadBilling) {
      setEntitlements(null);
      setEntitlementsError(null);
      return;
    }
    try {
      setEntitlements(await client.getBillingEntitlements({ accountId }));
      setEntitlementsError(null);
    } catch (error) {
      setEntitlements(null);
      setEntitlementsError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function refresh() {
    await Promise.all([refreshApiKeys(), refreshBilling(), refreshEntitlements()]);
  }

  async function createKey() {
    if (!apiKeyName.trim() || requestedPermissions.length === 0) {
      toast.error("API key name and permissions are required");
      return;
    }
    setBusy(true);
    try {
      const result = await client.createApiKey(workspaceId, {
        name: apiKeyName.trim(),
        permissions: requestedPermissions,
      });
      setCreatedToken(result.token);
      setApiKeys((current) => [result.apiKey, ...current]);
      toast.success("API key created");
    } catch (error) {
      toast.error("Failed to create API key", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(apiKeyId: string) {
    setBusy(true);
    try {
      const revoked = await client.deleteApiKey(workspaceId, apiKeyId);
      setApiKeys((current) => current.map((key) => key.id === revoked.id ? revoked : key));
      toast.success("API key revoked");
    } catch (error) {
      toast.error("Failed to revoke API key", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout(amountUsd: number) {
    setBusy(true);
    try {
      const checkout = await client.createBillingCheckout({ amountUsd, ...(accountId ? { accountId } : {}) });
      window.location.assign(checkout.url);
    } catch (error) {
      toast.error("Checkout failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function togglePermission(permission: string) {
    setSelectedPermissions((current) => {
      const next = new Set(current);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <section className="grid gap-5 text-left">
        <PageHeader
          icon={<UserIcon className="size-4" />}
          title="Account"
          description={context.authSession?.user.email ?? context.accessContext.subjectLabel ?? context.accessContext.subjectId}
          actions={context.clientConfig.auth.mode === "managedSession" ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void context.handleManagedSignOut().catch((error) => toast.error("Sign out failed", { description: String(error) }))}>
              <LockIcon className="size-3.5" />
              Sign out
            </Button>
          ) : undefined}
        />

        <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Credits</h2>
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                {billing
                  ? `${formatMoneyMicros(billing.balance.balanceMicros, billing.balance.currency)} available`
                  : !canReadBilling || !accountId
                    ? "This subject cannot read billing for the account."
                    : billingError
                      ? "Billing balance failed to load."
                      : "Billing balance unavailable"}
              </p>
            </div>
            <span className="rounded-full border border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]">
              {billing?.mode ?? "unknown"}
            </span>
          </div>
          {billingError ? (
            <LoadErrorState title="Couldn't load the billing balance" error={billingError} onRetry={() => void refreshBilling()} />
          ) : null}
          {billing?.mode === "stripe" && canManageBilling ? (
            <div className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <label className="grid gap-1">
                  <span className="sr-only">Credit amount</span>
                  <input
                    className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 text-sm outline-none focus:border-[color:var(--color-fg-muted)]"
                    inputMode="decimal"
                    min="5"
                    max="10000"
                    step="0.01"
                    value={topupAmount}
                    onChange={(event) => setTopupAmount(event.target.value)}
                  />
                </label>
                <Button type="button" variant="secondary" size="sm" disabled={busy || !validTopupAmount(topupAmount)} onClick={() => void startCheckout(Number(topupAmount))}>
                  Add credits
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {[25, 100, 500, 1000].map((amount) => (
                  <Button key={amount} type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setTopupAmount(amount.toFixed(2))}>
                    {formatMoneyMicros(amount * 1_000_000, "usd")}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-[color:var(--color-fg-subtle)]">Minimum top-up is $5.00.</p>
            </div>
          ) : (
            <p className="text-xs text-[color:var(--color-fg-subtle)]">Credit checkout is available when Stripe billing is enabled for this deployment.</p>
          )}
        </section>

        <EntitlementsSection
          enabled={canReadBilling && Boolean(accountId)}
          entitlements={entitlements}
          error={entitlementsError}
          onRetry={() => void refreshEntitlements()}
        />

        <UsageSection
          enabled={canReadBilling && Boolean(accountId)}
          loading={usage.loading}
          error={usage.error}
          usage={usage.usage}
          onRefresh={() => void usage.refresh()}
        />

        <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
          <div>
            <h2 className="text-sm font-medium">API keys</h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Workspace-scoped keys for calling OpenGeni from another product.</p>
          </div>
          {createdToken ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="text-xs font-medium text-emerald-200">Token shown once</div>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-[color:var(--color-bg)] px-2 py-1.5 text-xs">{createdToken}</code>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => void navigator.clipboard.writeText(createdToken)}>
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
          {canManageApiKeys ? (
            <>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} className="h-9" />
                <Button type="button" disabled={busy} onClick={() => void createKey()}>
                  {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Create
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-[color:var(--color-fg-subtle)]">A key can only carry permissions your own grant can delegate.</p>
                <Button type="button" variant="ghost" size="sm" disabled={delegablePermissions.size === 0} onClick={() => setSelectedPermissions(new Set(delegablePermissions))}>
                  Select all delegable
                </Button>
              </div>
              <PermissionGroupPicker
                groups={apiKeyPermissionGroups}
                selected={selectedPermissions}
                delegable={delegablePermissions}
                onToggle={togglePermission}
              />
            </>
          ) : (
            <p className="text-xs text-[color:var(--color-fg-subtle)]">This subject cannot manage API keys for the selected workspace.</p>
          )}
          <div className="grid gap-2">
            {apiKeysError ? (
              <LoadErrorState title="Couldn't load API keys" error={apiKeysError} onRetry={() => void refreshApiKeys()} />
            ) : apiKeys.length === 0 ? (
              <EmptyState>No API keys.</EmptyState>
            ) : apiKeys.map((apiKey) => (
              <div key={apiKey.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{apiKey.name}</div>
                  <div className="mt-1 truncate text-xs text-[color:var(--color-fg-subtle)]">{apiKey.prefix}... · {apiKey.revokedAt ? "revoked" : "active"}</div>
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={busy || Boolean(apiKey.revokedAt)} onClick={() => void revokeKey(apiKey.id)}>
                  <Trash2Icon className="size-3.5" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

/** Aggregate usage events by type for the honest at-a-glance summary. */
export function aggregateUsage(events: UsageEvent[]): Array<{ eventType: string; unit: string; total: number; count: number }> {
  const byKey = new Map<string, { eventType: string; unit: string; total: number; count: number }>();
  for (const event of events) {
    const key = `${event.eventType}\u0000${event.unit}`;
    const entry = byKey.get(key) ?? { eventType: event.eventType, unit: event.unit, total: 0, count: 0 };
    entry.total += event.quantity;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType));
}

/** Plan & entitlements (/v1/billing/entitlements): the limits the account runs under. */
function EntitlementsSection(props: {
  enabled: boolean;
  entitlements: BillingEntitlementsResponse | null;
  error: Error | null;
  onRetry: () => void;
}) {
  const rows = props.entitlements ? entitlementEntries(props.entitlements.entitlements) : [];
  return (
    <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <GaugeIcon className="size-3.5 text-[color:var(--color-brand)]" />
            Plan entitlements
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">The limits and features this account runs under.</p>
        </div>
        <span className="rounded-full border border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]">
          {props.entitlements?.mode ?? "unknown"}
        </span>
      </div>

      {!props.enabled ? (
        <p className="text-xs text-[color:var(--color-fg-subtle)]">This subject cannot read billing entitlements for the account.</p>
      ) : props.error ? (
        <LoadErrorState title="Couldn't load entitlements" error={props.error} onRetry={props.onRetry} />
      ) : !props.entitlements ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading entitlements
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-[color:var(--color-fg-subtle)]">No entitlement limits — this deployment does not restrict the account.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((row) => (
            <span key={row.name} className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 px-2 py-1 text-xs">
              <span className="font-medium">{row.name}</span>
              <span className="font-mono text-[11px] text-[color:var(--color-fg-muted)]">{row.value}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageSection(props: {
  enabled: boolean;
  loading: boolean;
  error: Error | null;
  usage: UsageEvent[];
  onRefresh: () => void;
}) {
  const summary = useMemo(() => aggregateUsage(props.usage), [props.usage]);
  return (
    <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <ActivityIcon className="size-3.5 text-[color:var(--color-brand)]" />
            Usage
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Recent metered events for this account, straight from the billing ledger.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!props.enabled || props.loading} onClick={props.onRefresh}>
          <RefreshCwIcon className={props.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </div>

      {!props.enabled ? (
        <p className="text-xs text-[color:var(--color-fg-subtle)]">This subject cannot read billing usage for the account.</p>
      ) : props.error && props.usage.length === 0 ? (
        // Honest failed-load state: a failed usage read must never render as
        // "No usage recorded yet." (usage already on screen keeps rendering).
        <LoadErrorState title="Couldn't load usage" error={props.error} onRetry={props.onRefresh} />
      ) : props.loading && props.usage.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading usage
        </div>
      ) : props.usage.length === 0 ? (
        <p className="text-xs text-[color:var(--color-fg-subtle)]">No usage recorded yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {summary.map((entry) => (
              <span key={`${entry.eventType}:${entry.unit}`} className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 px-2 py-1 text-xs">
                <span className="font-medium">{entry.eventType}</span>
                <span className="font-mono text-[11px] text-[color:var(--color-fg-muted)]">
                  {Number.isInteger(entry.total) ? entry.total : entry.total.toFixed(4)} {entry.unit}
                </span>
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="border-b border-[color:var(--color-border)] text-[color:var(--color-fg)]">
                <tr>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Event</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Quantity</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Source</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Occurred</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-border)]/70">
                {props.usage.slice(0, 30).map((event) => (
                  <tr key={event.id}>
                    <td className="px-2 py-1.5 text-[color:var(--color-fg-muted)]">{event.eventType}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[color:var(--color-fg-muted)]">
                      {Number.isInteger(event.quantity) ? event.quantity : event.quantity.toFixed(6)} {event.unit}
                    </td>
                    <td className="max-w-44 truncate px-2 py-1.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">
                      {event.sourceResourceType ? `${event.sourceResourceType}:${event.sourceResourceId ?? ""}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[color:var(--color-fg-subtle)]">{formatTimestamp(event.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
