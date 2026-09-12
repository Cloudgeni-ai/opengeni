import { DeviceAuthorization, type DeviceAuthorizationProps } from "@opengeni/react/connect";
import { CheckIcon, CopyIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Native subscription styling over the shared clipboard and URL-validation behavior. */
export function SubscriptionDeviceCodePanel({
  provider,
  ...props
}: Pick<
  DeviceAuthorizationProps,
  "userCode" | "verificationUri" | "loadClipboard" | "onCopyResult"
> & {
  provider: "codex" | "supergrok";
}) {
  const codex = provider === "codex";
  return (
    <DeviceAuthorization
      {...props}
      render={({ copied, copyError, copy, verificationHref }) => (
        <section
          aria-label={codex ? "Codex device authorization" : "SuperGrok device authorization"}
          className={
            codex
              ? "grid gap-2 rounded-md border border-border bg-bg p-3"
              : "grid gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3"
          }
        >
          {codex ? (
            <p className="text-xs text-fg-muted">
              Enter this code at the OpenAI page (opened in a new tab). Authorization continues if
              you navigate away.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <code
              {...(codex ? { "data-codex-device-code": "" } : { "data-supergrok-device-code": "" })}
              className={
                codex
                  ? "min-w-0 wrap-anywhere rounded bg-surface-2 px-3 py-1.5 text-lg font-semibold tracking-widest"
                  : "min-w-0 wrap-anywhere rounded bg-bg px-2 py-1 font-mono text-sm"
              }
            >
              {props.userCode}
            </code>
            <Button
              type="button"
              variant={codex ? "secondary" : "outline"}
              size="sm"
              aria-label={copied ? "Code copied" : "Copy code"}
              onClick={() => void copy()}
            >
              {copied ? (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <CopyIcon className="size-3.5" aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy code"}
            </Button>
            {verificationHref ? (
              <Button asChild variant={codex ? "secondary" : "outline"} size="sm">
                <a href={verificationHref} target="_blank" rel="noopener noreferrer">
                  {codex ? "Open auth page" : "Open xAI"}
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
            ) : (
              <span role="alert" className="text-xs text-destructive">
                Authorization address unavailable.
              </span>
            )}
          </div>
          {copyError ? (
            <p role="alert" className="text-xs text-destructive">
              Couldn't copy the code. Copy it manually instead.
            </p>
          ) : null}
          <p role="status" className="flex items-center gap-2 text-xs text-fg-subtle">
            <Loader2Icon
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {codex ? "Waiting for authorization…" : "Waiting for xAI authorization…"}
          </p>
        </section>
      )}
    />
  );
}
