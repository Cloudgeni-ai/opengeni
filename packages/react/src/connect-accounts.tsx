import { useEffect, useRef, useState } from "react";
import type { ConnectAccount, ConnectController } from "@opengeni/connect";
import { useConnect } from "./connect";

export type ConnectAccountsProps = {
  controller: ConnectController;
  className?: string;
  /** Enables explicit account-bound reconnect. Host supplies the exact destination. */
  returnUrl?: string;
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

function ScopedAccounts({ controller, className, returnUrl }: ConnectAccountsProps) {
  const view = useConnect(controller);
  const [accounts, setAccounts] = useState<ConnectAccount[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setAccounts(null);
    setSelected(null);
    setError(false);
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return controller.transport.accounts(controller.workspaceId, { signal: abort.signal });
      })
      .then((result) => {
        if (!abort.signal.aborted) setAccounts(structuredClone(result));
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [controller, reload]);

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
      {error && (
        <p role="alert">Account state could not be confirmed. Reload before trying again.</p>
      )}
      {!accounts && !error && <p role="status">Loading accounts…</p>}
      {accounts?.length === 0 && <p role="status">No connected accounts.</p>}
      {accounts && accounts.length > 0 && (
        <ul>
          {accounts.map((account) => (
            <li key={`${account.providerId}:${account.id}`}>
              <span>
                {account.label} — {account.providerId} — {account.ownership} —{" "}
                {account.status.replaceAll("_", " ")}
              </span>
              {returnUrl && (
                <button
                  type="button"
                  disabled={busy || view.busy || account.status === "disabled"}
                  onClick={() => void reconnect(account)}
                >
                  Reconnect {account.label}
                </button>
              )}
              {selected === `${account.providerId}:${account.id}` ? (
                <div role="group" aria-label={`Disconnect ${account.label}`}>
                  <p>
                    This removes local OpenGeni access. It does not revoke consent at the provider.
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
                  disabled={
                    busy ||
                    view.busy ||
                    account.status === "disabled" ||
                    !Number.isSafeInteger(account.version) ||
                    account.version! < 1
                  }
                  onClick={() => setSelected(`${account.providerId}:${account.id}`)}
                >
                  Disconnect {account.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
        Reload accounts
      </button>
    </section>
  );
}
