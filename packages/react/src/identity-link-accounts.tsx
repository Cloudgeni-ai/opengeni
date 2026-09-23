import { useEffect, useRef, useState } from "react";
import type { ExternalIdentityLink, ExternalIdentityLinkPage } from "@opengeni/sdk";

export type IdentityLinkAccountsClient = {
  listIdentityLinks(workspaceId: string, cursor?: string): Promise<ExternalIdentityLinkPage>;
  revokeIdentityLink(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<ExternalIdentityLink>;
};

/** Participant-scoped inventory. Revocation never deletes native work or merges
 * identities. The caller remounts this component when the signed-in user changes. */
export function IdentityLinkAccounts({
  client,
  workspaceId,
}: {
  client: IdentityLinkAccountsClient;
  workspaceId: string;
}) {
  const [links, setLinks] = useState<ExternalIdentityLink[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    inFlight.current = true;
    setLinks([]);
    setCursor(null);
    setBusy(true);
    setError(false);
    void client
      .listIdentityLinks(workspaceId)
      .then(
        (page) => {
          if (current !== generation.current) return;
          setLinks(page.links);
          setCursor(page.nextCursor);
        },
        () => {
          if (current === generation.current) setError(true);
        },
      )
      .finally(() => {
        if (current === generation.current) {
          inFlight.current = false;
          setBusy(false);
        }
      });
    return () => {
      // Invalidate live async work, rather than cleaning up a captured DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [client, workspaceId, revision]);

  async function act(link?: ExternalIdentityLink) {
    if (inFlight.current || (!link && !cursor)) return;
    const current = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      if (link) {
        const updated = await client.revokeIdentityLink(workspaceId, link.id, link.revision);
        if (current === generation.current)
          setLinks((values) =>
            values.map((value) => (value.id === updated.id ? { ...value, ...updated } : value)),
          );
      } else {
        const page = await client.listIdentityLinks(workspaceId, cursor!);
        if (current === generation.current) {
          setLinks((values) => [
            ...new Map([...values, ...page.links].map((value) => [value.id, value])).values(),
          ]);
          setCursor(page.nextCursor);
        }
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="og-connect og-identity-link"
      aria-label="Linked product access"
      aria-busy={busy}
    >
      <h2>Linked product access</h2>
      <p>
        Manage products allowed to act as your account in this organization. Revoking a link stops
        future linked access; it does not delete your work or undo an operation already started.
      </p>
      {error && (
        <div role="alert">
          Could not update account links. Reload to see current access.
          <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
            Reload links
          </button>
        </div>
      )}
      {busy && <p role="status">Loading account links…</p>}
      {!busy && !error && links.length === 0 && (
        <p>No products have linked access to this account.</p>
      )}
      <ul>
        {links.map((link) => (
          <li key={link.id}>
            <p>
              {link.externalIdentity?.source || "Product identity"}{" "}
              <code>{link.externalIdentity?.externalId ?? link.externalIdentityId}</code>
            </p>
            <p>
              Status: {link.status}.{" "}
              {link.expiresAt
                ? `Expires ${new Date(link.expiresAt).toLocaleString()}.`
                : "No automatic expiry."}
            </p>
            <p>{link.permissions.join(", ")}</p>
            {(link.status === "active" || link.status === "pending") && (
              <button type="button" disabled={busy} onClick={() => void act(link)}>
                Revoke access
              </button>
            )}
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" disabled={busy} onClick={() => void act()}>
          Load more links
        </button>
      )}
    </section>
  );
}
