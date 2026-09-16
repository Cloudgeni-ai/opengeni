import { useEffect, useRef, useState } from "react";
import type { ConnectAccount, ConnectController } from "@opengeni/connect";
import { useConnect } from "./hooks/use-connect";
import { ConnectAccountIdentity } from "./connect-account-identity";
import { ConnectionSkeleton } from "./connection-skeleton";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";

export type ConnectAccountsProps = {
  controller: ConnectController;
  className?: string;
  /** Enables explicit account-bound reconnect. Host supplies the exact destination. */
  returnUrl?: string;
  /** Uses authenticated catalogue assets and exact connection references for service identity. */
  client?: OpenGeniClient | undefined;
};

/** Local credential revocation only. Unknown or changed versions must be
 * refreshed; this component never retries a destructive operation implicitly. */
export function ConnectAccounts(props: ConnectAccountsProps) {
  const [scope, setScope] = useState(props.controller);
  const [generation, setGeneration] = useState(0);
  if (scope !== props.controller) {
    setScope(props.controller);
    setGeneration(generation + 1);
  }
  return <ScopedAccounts key={generation} {...props} />;
}

function ScopedAccounts({ controller, className, returnUrl, client }: ConnectAccountsProps) {
  const view = useConnect(controller);
  const [accounts, setAccounts] = useState<ConnectAccount[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [catalog, setCatalog] = useState<{
    client: OpenGeniClient;
    items: CapabilityCatalogItem[];
  } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setAccounts(null);
    setCatalog(null);
    setSelected(null);
    setError(false);
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return Promise.all([
          controller.transport.accounts(controller.workspaceId, { signal: abort.signal }),
          client?.listCapabilities(controller.workspaceId).catch(() => null) ?? null,
        ]);
      })
      .then(([result, metadata]) => {
        if (!abort.signal.aborted) {
          setAccounts(structuredClone(result));
          if (client && metadata) setCatalog({ client, items: metadata.items });
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [client, controller, reload]);

  const disconnect = async (account: ConnectAccount) => {
    const expectedVersion = account.version;
    if (
      mutation.current ||
      view.busy ||
      expectedVersion === undefined ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    )
      return;
    const abort = new AbortController();
    mutation.current = abort;
    setBusy(true);
    setError(false);
    try {
      await controller.transport.disconnect(controller.workspaceId, account.id, {
        expectedVersion,
        signal: abort.signal,
      });
      if (!abort.signal.aborted) setReload((value) => value + 1);
    } catch {
      if (!abort.signal.aborted) {
        // Outcome may be unknown. Drop the inventory so a second click cannot
        // replay against the stale selection; let the host reload live state.
        setAccounts(null);
        setError(true);
      }
    } finally {
      if (!abort.signal.aborted) {
        mutation.current = null;
        setBusy(false);
        setSelected(null);
      }
    }
  };
  const reconnect = async (account: ConnectAccount) => {
    if (!returnUrl || mutation.current || view.busy) return;
    setError(false);
    try {
      await controller.begin({
        providerId: account.providerId,
        ownership: account.ownership,
        reconnectAccountId: account.id,
        returnUrl,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch {
      setError(true);
    }
  };

  return (
    <section
      className={className}
      aria-label="Connected accounts"
      aria-busy={busy || view.busy || (!accounts && !error)}
    >
      <h3>Your connections</h3>
      {error && (
        <p role="alert">Account state could not be confirmed. Reload before trying again.</p>
      )}
      {!accounts && !error && <ConnectionSkeleton label="Loading accounts" />}
      {accounts?.length === 0 && <p role="status">No connected accounts.</p>}
      {accounts && accounts.length > 0 && (
        <ul>
          {accounts.map((account) => (
            <li className="og-connect-account" key={`${account.providerId}:${account.id}`}>
              <details className="og-connect-account-details">
                <summary className="og-connect-account-heading">
                  <ConnectAccountIdentity
                    account={account}
                    client={client}
                    capabilities={catalog?.client === client ? (catalog?.items ?? []) : []}
                  />
                  <span className="og-connect-account-status" data-status={account.status}>
                    {account.status === "connected"
                      ? "✓ Connected"
                      : account.status === "auth_needed"
                        ? "Reconnect needed"
                        : "Disconnected"}
                  </span>
                  <svg
                    className="og-connect-account-chevron"
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </summary>
                <div className="og-connect-account-actions">
                  {returnUrl && account.status === "auth_needed" && (
                    <button
                      type="button"
                      aria-label={`Reconnect ${account.label}`}
                      disabled={busy || view.busy}
                      onClick={() => void reconnect(account)}
                    >
                      Reconnect
                    </button>
                  )}
                  {selected === `${account.providerId}:${account.id}` ? (
                    <div role="group" aria-label={`Disconnect ${account.label}`}>
                      <p>
                        This removes local OpenGeni access. It does not revoke consent at the
                        provider.
                      </p>
                      <button
                        type="button"
                        disabled={busy || view.busy}
                        onClick={() => void disconnect(account)}
                      >
                        Confirm disconnect
                      </button>
                      <button type="button" disabled={busy} onClick={() => setSelected(null)}>
                        Keep account
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Disconnect ${account.label}`}
                      disabled={
                        busy ||
                        view.busy ||
                        account.status === "disabled" ||
                        !Number.isSafeInteger(account.version) ||
                        account.version! < 1
                      }
                      onClick={() => setSelected(`${account.providerId}:${account.id}`)}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      <button
        hidden={!error}
        type="button"
        disabled={busy}
        onClick={() => setReload((value) => value + 1)}
      >
        Reload accounts
      </button>
    </section>
  );
}
