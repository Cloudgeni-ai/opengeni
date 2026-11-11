import { useEffect, useRef, useState } from "react";
import type { ExternalIdentityLink, ExternalIdentityLinkPage } from "@opengeni/sdk";
import { useOpenGeniText } from "./messages/runtime";

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
  const t = useOpenGeniText();
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
      aria-label={t("identityLinkAccounts.linkedProductAccess")}
      aria-busy={busy}
    >
      <h2>{t("identityLinkAccounts.linkedProductAccess")}</h2>
      <p>{t("identityLinkAccounts.manageProductsAllowedToAct")}</p>
      {/* The links sit in one card under the heading, like a settings section;
          the empty and loading lines are rows of that card. */}
      <div className="og-identity-link-card">
        {error && (
          <div role="alert">
            {t("identityLinkAccounts.couldNotUpdateAccountLinks")}
            <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
              {t("identityLinkAccounts.reloadLinks")}
            </button>
          </div>
        )}
        {busy && <p role="status">{t("identityLinkAccounts.loadingAccountLinks")}</p>}
        {!busy && !error && links.length === 0 && (
          <p>{t("identityLinkAccounts.noProductsHaveLinkedAccess")}</p>
        )}
        <ul>
          {links.map((link) => (
            <li key={link.id}>
              <p>
                {link.externalIdentity?.source || t("identityLinkAccounts.productIdentity")}{" "}
                <code>{link.externalIdentity?.externalId ?? link.externalIdentityId}</code>
              </p>
              <p>
                {t("identityLinkAccounts.statusStatus", { status: link.status })}{" "}
                {link.expiresAt
                  ? t("identityLinkAccounts.expiresLocalestring", {
                      localeString: new Date(link.expiresAt).toLocaleString(t.locale),
                    })
                  : t("identityLinkAccounts.noAutomaticExpiry")}
              </p>
              <p>{link.permissions.join(", ")}</p>
              {(link.status === "active" || link.status === "pending") && (
                <button type="button" disabled={busy} onClick={() => void act(link)}>
                  {t("identityLinkAccounts.revokeAccess")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {cursor && (
          <button type="button" disabled={busy} onClick={() => void act()}>
            {t("identityLinkAccounts.loadMoreLinks")}
          </button>
        )}
      </div>
    </section>
  );
}
