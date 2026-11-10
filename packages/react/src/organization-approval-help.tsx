import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "./lib/clipboard";
import { useOpenGeniText } from "./messages/runtime";
import { organizationApprovalMessage, type OrganizationApproval } from "./connect-setup-model";

function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className: string;
}) {
  const t = useOpenGeniText();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      className={className}
      onClick={() =>
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      <span aria-live="polite">{copied ? t("copyButton.copied") : label}</span>
    </button>
  );
}

export type OrganizationApprovalHelpProps = {
  approval: OrganizationApproval;
  /** The service being connected ("Outlook Mail"), named in the message for IT. */
  serviceName?: string | undefined;
  /** Start a fresh sign-in once the administrator approved. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean | undefined;
};

/**
 * What a person does when their organization must approve the app first: send
 * IT a ready-made message with the approval link (or the app's ID), open the
 * link themselves if they are an admin, and sign in again afterwards. Every
 * word comes from the message catalog, so a host can say it its own way.
 */
export function OrganizationApprovalHelp({
  approval,
  serviceName,
  onRetry,
  retryDisabled,
}: OrganizationApprovalHelpProps) {
  const t = useOpenGeniText();
  const message = organizationApprovalMessage(t, approval, serviceName);
  const unfinished = approval.reason === "unfinished";
  return (
    <div
      className={unfinished ? "og-connect-setup-approval-note" : "og-connect-setup-approval"}
      data-reason={approval.reason}
    >
      <div className="og-connect-setup-approval-copy">
        <p role="status" className="og-connect-setup-approval-title">
          {approval.reason === "required"
            ? t("connectSetup.organizationApprovalRequiredTitle")
            : approval.reason === "possible"
              ? t("connectSetup.organizationApprovalPossibleTitle")
              : t("connectSetup.organizationApprovalUnfinishedTitle")}
        </p>
        <p className="og-connect-setup-description">
          {approval.reason === "required"
            ? t("connectSetup.microsoftAdminApprovalRequired")
            : approval.reason === "possible"
              ? t("connectSetup.microsoftAdminApprovalMaybe")
              : t("connectSetup.organizationApprovalUnfinished")}
        </p>
      </div>
      {message && (
        <details className="og-connect-setup-approval-message">
          <summary>{t("connectSetup.showMessageForIt")}</summary>
          <p>{message}</p>
        </details>
      )}
      <div className="og-connect-setup-approval-actions">
        {message && (
          <CopyButton
            text={message}
            label={t("connectSetup.copyMessageForIt")}
            className={unfinished ? "og-connect-setup-approval-button" : "og-connect-setup-primary"}
          />
        )}
        {approval.url && (
          <CopyButton
            text={approval.url}
            label={t("connectSetup.copyAdminApprovalLink")}
            className="og-connect-setup-approval-action"
          />
        )}
        {approval.url && (
          <a
            className="og-connect-setup-approval-action"
            href={approval.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("connectSetup.openApprovalLinkAsAdmin")}
            <span className="sr-only"> {t("connectSetup.opensInNewTab")}</span>
          </a>
        )}
        {onRetry && (
          <button
            type="button"
            disabled={retryDisabled}
            className="og-connect-setup-approval-action"
            onClick={onRetry}
          >
            {t("connectSetup.trySigningInAgain")}
          </button>
        )}
      </div>
    </div>
  );
}
