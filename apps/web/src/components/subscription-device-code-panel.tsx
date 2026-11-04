import { DeviceAuthorization, type DeviceAuthorizationProps } from "@opengeni/react/connect";
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";

/* ----------------------------------------------------------------------------
   Signing in to a subscription with a device code (ChatGPT for Codex, xAI for
   SuperGrok), as one calm step: one instruction, the code with Copy code and
   Open sign-in page, and one waiting line. The connect pages and onboarding
   share it, so the step reads the same everywhere, including the "Still
   waiting?" notice that names what can block the code.
   -------------------------------------------------------------------------- */

type Provider = "codex" | "supergrok";

const SIGN_IN_SITE: Record<Provider, string> = { codex: "ChatGPT", supergrok: "xAI" };

/** ChatGPT keeps device code sign-in behind a per-account (or workspace-admin) setting. */
export const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";
/** Show troubleshooting once a device sign-in has waited this long. */
export const DEVICE_LOGIN_HINT_DELAY_MS = 60 * 1_000;

/**
 * The provider refuses a code on its own page and never tells the poll, which
 * keeps waiting. So once the wait is long, say what usually blocks it.
 */
function StillWaitingNotice({ provider }: { provider: Provider }) {
  if (provider === "supergrok") {
    return (
      <Notice tone="waiting" title="Still waiting?">
        Check that you entered the code exactly as shown and approved access on the xAI page. If the
        code expired, try again.
      </Notice>
    );
  }
  return (
    <Notice
      tone="waiting"
      title="Still waiting?"
      actionLayout="responsive"
      action={
        <a
          className="text-sm font-medium text-fg underline underline-offset-2"
          href={CHATGPT_SECURITY_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
        >
          Open ChatGPT settings
        </a>
      }
    >
      If ChatGPT refused the code, turn on “Enable device code sign-in for Codex” in Settings →
      Security and login (on Business and Enterprise, a ChatGPT admin allows it), then try again.
    </Notice>
  );
}

/** True once this code has waited `DEVICE_LOGIN_HINT_DELAY_MS`; a new code starts over. */
function useWaitedLong(userCode: string): boolean {
  // Remember which code waited long, so a new code never shows the old notice.
  const [slowCode, setSlowCode] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSlowCode(userCode), DEVICE_LOGIN_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [userCode]);
  return slowCode === userCode;
}

/** Native subscription styling over the shared clipboard and URL-validation behavior. */
export function SubscriptionDeviceCodePanel({
  provider,
  ...props
}: Pick<
  DeviceAuthorizationProps,
  "userCode" | "verificationUri" | "loadClipboard" | "onCopyResult"
> & {
  provider: Provider;
}) {
  const site = SIGN_IN_SITE[provider];
  const waitedLong = useWaitedLong(props.userCode);
  return (
    <DeviceAuthorization
      {...props}
      render={({ copied, copyError, copy, verificationHref }) => (
        <section aria-label={`${site} sign-in code`} className="flex min-w-0 flex-col gap-3">
          <p className="m-0 text-sm leading-5 text-fg-muted">
            {`Enter this code on the ${site} page that opened. Opengeni never sees your password.`}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code
              {...(provider === "codex"
                ? { "data-codex-device-code": "" }
                : { "data-supergrok-device-code": "" })}
              className="min-w-0 rounded-[10px] bg-surface-2 px-3 py-1 font-mono text-lg leading-7 font-semibold tracking-widest wrap-anywhere text-fg"
            >
              {props.userCode}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={copied ? "Code copied" : "Copy code"}
              onClick={() => void copy()}
              className="rounded-[10px] pointer-coarse:h-11"
            >
              {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
              {copied ? "Copied" : "Copy code"}
            </Button>
            {verificationHref ? (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="rounded-[10px] pointer-coarse:h-11"
              >
                <a href={verificationHref} target="_blank" rel="noopener noreferrer">
                  Open sign-in page
                  <ExternalLinkIcon aria-hidden="true" />
                </a>
              </Button>
            ) : (
              <span role="alert" className="text-xs text-danger">
                {`The ${site} sign-in page is unavailable. Try again.`}
              </span>
            )}
          </div>
          {copyError ? (
            <p role="alert" className="m-0 text-xs text-danger">
              Couldn't copy the code. Copy it manually instead.
            </p>
          ) : null}
          <p role="status" className="m-0 flex min-w-0 items-center gap-2 text-sm text-fg-muted">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-fg-subtle motion-safe:animate-spin"
            />
            Waiting for you to sign in…
          </p>
          {waitedLong ? <StillWaitingNotice provider={provider} /> : null}
        </section>
      )}
    />
  );
}

/**
 * The sign-in part of a connect page: before it starts, one line on what
 * happens; while it waits, the code step (`panel`); once done, "Connected".
 */
export function DeviceSignInStatus({
  provider,
  panel,
  connected,
}: {
  provider: Provider;
  /** The code step while the sign-in waits, else null. */
  panel: ReactNode;
  connected: boolean;
}) {
  if (connected) {
    return (
      <p role="status" className="m-0 flex min-w-0 items-center gap-2 text-sm text-fg-muted">
        <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
        Connected
      </p>
    );
  }
  if (panel) return <>{panel}</>;
  const site = SIGN_IN_SITE[provider];
  return (
    <p className="m-0 text-sm leading-5 text-fg-muted">
      {`${site} opens in a new tab and asks for a code, which shows here. Opengeni never sees your password.`}
    </p>
  );
}
