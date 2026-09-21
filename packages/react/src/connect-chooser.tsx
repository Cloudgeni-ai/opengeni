import { connectionServicePresentation } from "./connection-service-presentation";
import { ConnectionCatalog } from "./connection-catalog";
import { ConnectionLogo } from "./connection-logo";
import { useEffect, useState, type FormEvent } from "react";
import type { ConnectAccount, ConnectController, ConnectProvider } from "@opengeni/connect";
import { useConnect } from "./hooks/use-connect";

export type ConnectChooserProps = {
  controller: ConnectController;
  /** Exact host return string; no completion parameters are added. */
  returnUrl: string;
  className?: string;
  presentation?: "select" | "catalog";
  /** Compact mechanism picker when service discovery is already shown by the host. */
  customOnly?: boolean;
  providerOnly?: boolean;
  compact?: boolean;
  /** Select a service from the unified discovery list. */
  initialProviderId?: string;
};

/** Catalog readiness is supplied by the authenticated backend, never inferred
 * from the existence of a provider definition. Host replaces the controller on
 * actor/workspace change. This form does not open OAuth windows itself. */
export function ConnectChooser(props: ConnectChooserProps) {
  // Remount scope-local selections synchronously when the controller changes,
  // before effects can expose a previous actor's inventory for one frame.
  const [scope, setScope] = useState(props.controller);
  const [generation, setGeneration] = useState(0);
  if (scope !== props.controller) {
    setScope(props.controller);
    setGeneration(generation + 1);
  }
  return <ScopedChooser key={generation} {...props} />;
}

function ScopedChooser({
  controller,
  returnUrl,
  className,
  presentation = "select",
  customOnly = false,
  providerOnly = false,
  compact = false,
  initialProviderId = "",
}: ConnectChooserProps) {
  const view = useConnect(controller);
  const [catalog, setCatalog] = useState<ConnectProvider[] | null>(null);
  const [accounts, setAccounts] = useState<ConnectAccount[]>([]);
  const [failed, setFailed] = useState(false);
  const [load, setLoad] = useState(0);
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState(initialProviderId);
  const [ownership, setOwnership] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setCatalog(null);
    setAccounts([]);
    setFailed(false);
    setProviderId(initialProviderId);
    setOwnership("");
    // Promise boundary also handles a synchronously throwing injected transport.
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return Promise.all([
          controller.transport.catalog(controller.workspaceId, { signal: abort.signal }),
          presentation === "catalog"
            ? controller.transport.accounts(controller.workspaceId, { signal: abort.signal })
            : Promise.resolve([] as ConnectAccount[]),
        ]);
      })
      .then(([providers, inventory]) => {
        if (!abort.signal.aborted) {
          setCatalog(
            structuredClone(
              providers.filter(
                (entry) =>
                  entry.readiness === "available" &&
                  entry.ownership.length > 0 &&
                  (!providerOnly ||
                    (entry.family !== "mcp" &&
                      !entry.setup.some((kind) =>
                        ["installation", "openapi", "graphql"].includes(kind),
                      ))) &&
                  (!customOnly ||
                    entry.family === "mcp" ||
                    entry.setup.some((kind) =>
                      ["installation", "openapi", "graphql"].includes(kind),
                    )),
              ),
            ),
          );
          setAccounts(structuredClone(inventory));
          const initial = providers.find((entry) => entry.id === initialProviderId);
          if (initial)
            setOwnership(
              initial.ownership.includes("personal") &&
                ["google", "microsoft"].includes(initial.family)
                ? "personal"
                : initial.ownership.includes("workspace")
                  ? "workspace"
                  : (initial.ownership[0] ?? ""),
            );
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [controller, load, presentation, customOnly, providerOnly, initialProviderId]);
  const provider = catalog?.find((entry) => entry.id === providerId);
  const canBegin =
    provider?.readiness === "available" &&
    (ownership === "personal" || ownership === "workspace") &&
    provider.ownership.includes(ownership);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canBegin || view.busy || (ownership !== "personal" && ownership !== "workspace")) return;
    setFailed(false);
    try {
      void controller
        .begin({ providerId, ownership, returnUrl, idempotencyKey: crypto.randomUUID() })
        .catch(() => setFailed(true));
    } catch {
      setFailed(true);
    }
  };
  // Optional adapters must not add a temporary section that disappears once
  // readiness arrives. The primary discovery surface already owns loading.
  if (compact && (!catalog || catalog.length === 0) && !failed) return null;
  return (
    <section
      className={className}
      aria-label="Choose a connection"
      aria-busy={view.busy || (!catalog && !failed)}
    >
      {failed && (
        <p role="alert">
          Connections could not be loaded or started. Check setup status before retrying.
        </p>
      )}
      {!catalog && !failed && <p role="status">Loading connections…</p>}
      {catalog?.length === 0 && <p role="status">No connections are available.</p>}
      {Boolean(catalog?.length) && (
        <form onSubmit={submit}>
          <fieldset disabled={view.busy}>
            <legend hidden={customOnly || compact}>
              {presentation === "catalog" ? "Add a connection" : "Provider and ownership"}
            </legend>
            {presentation === "catalog" && !provider ? (
              <>
                <label hidden={customOnly || compact}>
                  Search connections
                  <input
                    type="search"
                    placeholder="Find a service…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {[
                  {
                    name: "Services",
                    entries: catalog!.filter(
                      (entry) =>
                        entry.readiness === "available" &&
                        entry.family !== "mcp" &&
                        !entry.setup.some((kind) =>
                          ["installation", "openapi", "graphql"].includes(kind),
                        ),
                    ),
                    secondary: false,
                  },
                  {
                    name: "Custom connections",
                    entries: catalog!.filter(
                      (entry) =>
                        entry.readiness === "available" &&
                        (entry.family === "mcp" ||
                          entry.setup.some((kind) =>
                            ["installation", "openapi", "graphql"].includes(kind),
                          )),
                    ),
                    secondary: true,
                  },
                ].map((group) => {
                  const entries = group.entries.filter((entry) =>
                    entry.label.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
                  );
                  if (!entries.length) return null;
                  const rows = (
                    <ConnectionCatalog
                      services={entries.map((entry) => {
                        const connected = accounts.some(
                          (account) =>
                            account.providerId === entry.id && account.status === "connected",
                        );
                        return {
                          id: entry.id,
                          name: entry.label,
                          logo: (
                            <ConnectionLogo
                              src={connectionServicePresentation(entry).logo}
                              name={entry.label}
                            />
                          ),
                          options: [
                            {
                              id: entry.id,
                              name: entry.label,
                              status: connected
                                ? "Connected"
                                : entry.readiness === "available"
                                  ? "Connect"
                                  : "Unavailable",
                              state: connected
                                ? "added"
                                : entry.readiness === "available"
                                  ? "available"
                                  : "unavailable",
                              connected,
                              onOpen: () => {
                                if (!view.busy) {
                                  setProviderId(entry.id);
                                  setOwnership(
                                    entry.ownership.length === 1 ? entry.ownership[0]! : "",
                                  );
                                }
                              },
                            },
                          ],
                        };
                      })}
                    />
                  );
                  return group.secondary && !customOnly ? (
                    <details
                      className="og-connect-secondary"
                      key={group.name}
                      open={query.trim() ? true : undefined}
                    >
                      <summary>
                        {group.name}
                        <span>{entries.length}</span>
                      </summary>
                      {rows}
                    </details>
                  ) : (
                    <div key={group.name}>{rows}</div>
                  );
                })}
                {!catalog!.some((entry) =>
                  entry.label.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
                ) && <p role="status">No services match your search.</p>}
              </>
            ) : null}
            {presentation === "catalog" && provider && !initialProviderId ? (
              <button
                type="button"
                onClick={() => {
                  setProviderId("");
                  setOwnership("");
                }}
              >
                Back to connections
              </button>
            ) : null}
            <label hidden={presentation === "catalog"}>
              Provider
              <select
                required
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setOwnership("");
                }}
              >
                <option value="" disabled>
                  Choose a provider
                </option>
                {catalog!.map((entry) => (
                  <option
                    key={entry.id}
                    value={entry.id}
                    disabled={entry.readiness !== "available" || entry.ownership.length === 0}
                  >
                    {entry.label} — {entry.id} ({entry.readiness.replaceAll("_", " ")})
                  </option>
                ))}
              </select>
            </label>
            {provider && (
              <>
                <strong>{presentation === "catalog" ? provider.label : null}</strong>
                {provider.readiness !== "available" && (
                  <p role="status">
                    {provider.reason ??
                      "This service is not available in this environment. Contact your administrator to enable it."}
                  </p>
                )}
                <label>
                  Who can use this connection?
                  <select
                    required
                    value={ownership}
                    onChange={(event) => setOwnership(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose ownership
                    </option>
                    {provider.ownership.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice === "personal" ? "Only me" : "Everyone in this workspace"}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <button
              hidden={presentation === "catalog" && !provider}
              type="submit"
              disabled={!canBegin}
            >
              Continue
            </button>
          </fieldset>
        </form>
      )}
      <button hidden={!failed} type="button" disabled={view.busy} onClick={() => setLoad(load + 1)}>
        Reload providers
      </button>
    </section>
  );
}
