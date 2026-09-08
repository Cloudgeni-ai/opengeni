import { useEffect, useRef, useState } from "react";
import type {
  ExternalIdentityLink,
  ConfirmExternalIdentityLinkRequest,
  ExternalIdentityLinkPreview,
} from "@opengeni/sdk";

export type IdentityLinkClient = {
  previewIdentityLink(
    workspaceId: string,
    linkId: string,
    challenge: string,
  ): Promise<ExternalIdentityLinkPreview>;
  confirmIdentityLink(
    workspaceId: string,
    linkId: string,
    input: ConfirmExternalIdentityLinkRequest,
  ): Promise<ExternalIdentityLink>;
  revokeIdentityLink(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<ExternalIdentityLink>;
};
export type IdentityLinkConsentProps = {
  client: IdentityLinkClient;
  workspaceId: string;
  linkId: string;
  challenge: string;
  /** Host label is explanatory, never proof of the requesting application. */
  className?: string;
  onComplete?: (link: ExternalIdentityLink) => void;
};

/** Optional native-login consent. Ordinary Connect does not use this surface.
 * Permission choices only narrow the server's request; no automatic approval. */
export function IdentityLinkConsent({
  client,
  workspaceId,
  linkId,
  challenge,
  className,
  onComplete,
}: IdentityLinkConsentProps) {
  const [link, setLink] = useState<ExternalIdentityLink | null>(null);
  const [preview, setPreview] = useState<ExternalIdentityLinkPreview | null>(null);
  const [selected, setSelected] = useState<ExternalIdentityLink["permissions"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setLink(null);
    setPreview(null);
    setSelected([]);
    setBusy(true);
    setError(false);
    void client
      .previewIdentityLink(workspaceId, linkId, challenge)
      .then(
        (result) => {
          if (generation.current !== current) return;
          setPreview(result);
          setLink(result.link);
          setSelected(result.link.permissions);
        },
        () => {
          if (generation.current === current) setError(true);
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
    return () => {
      // Invalidate live async work, rather than cleaning up a captured DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [client, workspaceId, linkId, challenge, retry]);
  async function mutate(revoke: boolean) {
    if (!link || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(false);
    try {
      const result = revoke
        ? await client.revokeIdentityLink(workspaceId, linkId, link.revision)
        : await client.confirmIdentityLink(workspaceId, linkId, {
            challenge,
            expectedRevision: link.revision,
            permissions: selected,
          });
      if (generation.current !== current) return;
      setLink(result);
      onComplete?.(result);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <section
      className={["og-connect og-identity-link", className].filter(Boolean).join(" ")}
      aria-label="Link your account"
      aria-busy={busy}
    >
      <h2>Link your OpenGeni account</h2>
      <p>
        Only continue if you started this request in a product you trust. Linking lets that product
        act as your account with the permissions you select. It does not merge accounts or move
        existing work.
      </p>
      {preview && (
        <dl>
          <dt>Organization</dt>
          <dd>{preview.organizationId}</dd>
          <dt>Product user</dt>
          <dd>
            {preview.externalIdentity.externalId} ({preview.externalIdentity.source})
          </dd>
          <dt>Your OpenGeni identity</dt>
          <dd>{preview.nativeSubjectId}</dd>
        </dl>
      )}
      {error && (
        <div role="alert">
          This request could not be completed. It may have expired, changed, or require you to sign
          in to the right organization.
          {!link && (
            <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
      {!link && busy && <p role="status">Loading the account-link request…</p>}
      {link?.status === "pending" && (
        <>
          <p>
            {link.expiresAt
              ? `Access ends ${new Date(link.expiresAt).toLocaleString()}.`
              : "Access lasts until you or the product revoke this link."}{" "}
            Your current permissions still apply.
          </p>
          <fieldset disabled={busy}>
            <legend>Allow these permissions</legend>
            {link.permissions.map((permission) => (
              <label key={permission}>
                <input
                  type="checkbox"
                  checked={selected.includes(permission)}
                  onChange={(event) =>
                    setSelected((values) =>
                      event.target.checked
                        ? [...values, permission]
                        : values.filter((value) => value !== permission),
                    )
                  }
                />
                <span>{permission.replaceAll(":", " · ")}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={busy || selected.length === 0}
            onClick={() => void mutate(false)}
          >
            {busy ? "Saving…" : "Allow selected access"}
          </button>
          <p>You can close this page without granting access.</p>
        </>
      )}
      {link?.status === "active" && (
        <>
          <p role="status">Account linked. Return to your product to continue.</p>
          <button type="button" disabled={busy} onClick={() => void mutate(true)}>
            Revoke this link
          </button>
        </>
      )}
      {link?.status === "revoked" && (
        <p role="status">Link revoked. Your OpenGeni account and existing work are unchanged.</p>
      )}
      {link?.status === "expired" && (
        <p role="status">This request has expired. Start a new request from your product.</p>
      )}
    </section>
  );
}
