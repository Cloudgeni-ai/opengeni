import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "./clipboard";
import { useOpenGeniText } from "./messages/runtime";

export type DeviceAuthorizationProps = {
  userCode: string;
  verificationUri: string;
  providerLabel?: string;
  description?: string;
  className?: string;
  codeAttributes?: Record<`data-${string}`, string>;
  loadClipboard?: () => Promise<{ copyTextToClipboard(text: string): Promise<boolean> }>;
  onCopyResult?: (copied: boolean) => void;
  /** Optional host presentation; clipboard state and URL validation remain shared. */
  render?: (state: {
    copied: boolean;
    copyError: boolean;
    copy: () => Promise<void>;
    verificationHref: string | undefined;
  }) => ReactNode;
};

/** Optional presentation for the existing model-account device APIs. It neither
 * owns provider state nor assumes that opening a verification page completed it. */
export function DeviceAuthorization(props: DeviceAuthorizationProps) {
  const t = useOpenGeniText();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    generation.current++;
    setCopied(false);
    setCopyError(false);
    return () => {
      // This is a live async-operation counter, not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [props.userCode]);
  async function copy() {
    const revision = ++generation.current;
    if (timer.current) clearTimeout(timer.current);
    setCopied(false);
    setCopyError(false);
    try {
      const clipboard = props.loadClipboard ? await props.loadClipboard() : { copyTextToClipboard };
      if (revision !== generation.current) return;
      const success = await clipboard.copyTextToClipboard(props.userCode);
      if (revision !== generation.current) return;
      setCopied(success);
      setCopyError(!success);
      props.onCopyResult?.(success);
      if (success)
        timer.current = setTimeout(() => {
          if (revision === generation.current) setCopied(false);
        }, 1600);
    } catch {
      if (revision !== generation.current) return;
      setCopyError(true);
      props.onCopyResult?.(false);
    }
  }
  let href: string | undefined;
  try {
    const url = new URL(props.verificationUri);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      href = props.verificationUri;
  } catch {
    /* A malformed provider URL must never become an executable link. */
  }
  if (props.render) return props.render({ copied, copyError, copy, verificationHref: href });
  return (
    <section
      className={`og-connect ${props.className ?? ""}`}
      aria-label={t("deviceAuthorization.deviceAuthorization")}
    >
      <p>
        {props.description ??
          t("deviceAuthorization.enterThisCodeAtProviderlabel", {
            providerLabel: props.providerLabel ?? t("deviceAuthorization.theProvider"),
          })}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <code {...props.codeAttributes} style={{ overflowWrap: "anywhere" }}>
          {props.userCode}
        </code>
        <button
          type="button"
          aria-label={
            copied ? t("deviceAuthorization.codeCopied") : t("deviceAuthorization.copyCode")
          }
          onClick={() => void copy()}
        >
          {copied ? t("deviceAuthorization.copied") : t("deviceAuthorization.copyCode")}
        </button>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {t("deviceAuthorization.open")}{" "}
            {props.providerLabel ?? t("deviceAuthorization.authPage")}
          </a>
        ) : (
          <span role="alert">{t("deviceAuthorization.authorizationAddressUnavailable")}</span>
        )}
      </div>
      {copyError ? <p role="alert">{t("deviceAuthorization.couldnTCopyTheCode")}</p> : null}
      <p role="status">{t("deviceAuthorization.waitingForAuthorization")}</p>
    </section>
  );
}
