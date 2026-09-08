import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "./clipboard";

export type DeviceAuthorizationProps = {
  userCode: string;
  verificationUri: string;
  providerLabel?: string;
  description?: string;
  className?: string;
  codeAttributes?: Record<`data-${string}`, string>;
  loadClipboard?: () => Promise<{ copyTextToClipboard(text: string): Promise<boolean> }>;
  onCopyResult?: (copied: boolean) => void;
};

/** Optional presentation for the existing model-account device APIs. It neither
 * owns provider state nor assumes that opening a verification page completed it. */
export function DeviceAuthorization(props: DeviceAuthorizationProps) {
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
  return (
    <section className={`og-connect ${props.className ?? ""}`} aria-label="Device authorization">
      <p>{props.description ?? `Enter this code at ${props.providerLabel ?? "the provider"}.`}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <code {...props.codeAttributes} style={{ overflowWrap: "anywhere" }}>
          {props.userCode}
        </code>
        <button
          type="button"
          aria-label={copied ? "Code copied" : "Copy code"}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy code"}
        </button>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open {props.providerLabel ?? "auth page"}
          </a>
        ) : (
          <span role="alert">Authorization address unavailable.</span>
        )}
      </div>
      {copyError ? <p role="alert">Couldn't copy the code. Copy it manually instead.</p> : null}
      <p role="status">Waiting for authorization…</p>
    </section>
  );
}
