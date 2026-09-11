import { ConnectionCatalog } from "./connection-catalog";
import { useEffect, useState, type FormEvent } from "react";
import type { ConnectController, ConnectProvider } from "@opengeni/connect";
import { useConnect } from "./connect";

export type ConnectChooserProps = {
  controller: ConnectController;
  /** Exact host return string; no completion parameters are added. */
  returnUrl: string;
  className?: string;
  presentation?: "select" | "catalog";
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
}: ConnectChooserProps) {
  const view = useConnect(controller);
  const [catalog, setCatalog] = useState<ConnectProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [load, setLoad] = useState(0);
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState("");
  const [ownership, setOwnership] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setCatalog(null);
    setFailed(false);
    setProviderId("");
    setOwnership("");
    // Promise boundary also handles a synchronously throwing injected transport.
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return controller.transport.catalog(controller.workspaceId, { signal: abort.signal });
      })
      .then((providers) => {
        if (!abort.signal.aborted) setCatalog(structuredClone(providers));
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [controller, load]);
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
            <legend>Provider and ownership</legend>
            {presentation === "catalog" && !provider ? (
              <>
                <label>
                  Search connections
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <ConnectionCatalog
                  query={query}
                  services={catalog!.map((entry) => ({
                    id: entry.id,
                    name: entry.label,
                    options: [
                      {
                        id: entry.id,
                        name: entry.label,
                        description: entry.reason,
                        status: entry.readiness.replaceAll("_", " "),
                        connected: false,
                        onOpen: () => {
                          if (!view.busy) {
                            setProviderId(entry.id);
                            setOwnership(entry.ownership.length === 1 ? entry.ownership[0]! : "");
                          }
                        },
                      },
                    ],
                  }))}
                />
              </>
            ) : null}
            {presentation === "catalog" && provider ? (
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
                <label>
                  Ownership
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
                        {choice === "personal"
                          ? "Personal — owned by you"
                          : "Workspace — shared connection"}
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
              Start setup
            </button>
          </fieldset>
        </form>
      )}
      <button type="button" disabled={view.busy} onClick={() => setLoad(load + 1)}>
        Reload providers
      </button>
    </section>
  );
}
