import { useEffect, useRef, useState } from "react";
import type {
  ExternalIdentityLink,
  ConfirmExternalIdentityLinkRequest,
  ExternalIdentityLinkPreview,
} from "@opengeni/sdk";
import { useOpenGeniText } from "./messages/runtime";

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
  const t = useOpenGeniText();
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
      aria-label={t("identityLinkConsent.linkYourAccount")}
      aria-busy={busy}
    >
      <h2>{t("identityLinkConsent.linkYourOpengeniAccount")}</h2>
      <p>{t("identityLinkConsent.onlyContinueIfYouStarted")}</p>
      {preview && (
        <dl>
          <dt>{t("identityLinkConsent.organization")}</dt>
          <dd>{preview.organizationId}</dd>
          <dt>{t("identityLinkConsent.productUser")}</dt>
          <dd>
            {preview.externalIdentity.externalId} ({preview.externalIdentity.source})
          </dd>
          <dt>{t("identityLinkConsent.yourOpengeniIdentity")}</dt>
          <dd>{preview.nativeSubjectId}</dd>
        </dl>
      )}
      {error && (
        <div role="alert">
          {t("identityLinkConsent.thisRequestCouldNotBe")}
          {!link && (
            <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
              {t("identityLinkConsent.tryAgain")}
            </button>
          )}
        </div>
      )}
      {!link && busy && (
        <p role="status">{t("identityLinkConsent.loadingTheAccountLinkRequest")}</p>
      )}
      {link?.status === "pending" && (
        <>
          <p>
            {link.expiresAt
              ? t("identityLinkConsent.accessEndsLocalestring", {
                  localeString: new Date(link.expiresAt).toLocaleString(t.locale),
                })
              : t("identityLinkConsent.accessLastsUntilYouOr")}{" "}
            {t("identityLinkConsent.yourCurrentPermissionsStillApply")}
          </p>
          <fieldset disabled={busy}>
            <legend>{t("identityLinkConsent.allowThesePermissions")}</legend>
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
            {busy ? t("identityLinkConsent.saving") : t("identityLinkConsent.allowSelectedAccess")}
          </button>
          <p>{t("identityLinkConsent.youCanCloseThisPage")}</p>
        </>
      )}
      {link?.status === "active" && (
        <>
          <p role="status">{t("identityLinkConsent.accountLinkedReturnToYour")}</p>
          <button type="button" disabled={busy} onClick={() => void mutate(true)}>
            {t("identityLinkConsent.revokeThisLink")}
          </button>
        </>
      )}
      {link?.status === "revoked" && (
        <p role="status">{t("identityLinkConsent.linkRevokedYourOpengeniAccount")}</p>
      )}
      {link?.status === "expired" && (
        <p role="status">{t("identityLinkConsent.thisRequestHasExpiredStart")}</p>
      )}
    </section>
  );
}
