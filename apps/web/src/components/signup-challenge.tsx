import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@opengeni/react/ui/button";

type Turnstile = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  execute(widget: string): void;
  remove(id: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
let loader: Promise<Turnstile> | undefined;
function load(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return (loader ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = window.setTimeout(() => {
      script.remove();
      loader = undefined;
      reject(new Error("Verification timed out"));
    }, 15_000);
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else {
        loader = undefined;
        reject(new Error("Verification unavailable"));
      }
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      script.remove();
      loader = undefined;
      reject(new Error("Verification unavailable"));
    };
    document.head.append(script);
  }));
}

/** What a background signup challenge produced for one Google or GitHub click. */
export type SocialSignupChallengeOutcome =
  | { status: "verified"; token: string }
  /** No token: continue anyway. Existing people sign in; the server refuses a new account. */
  | { status: "unverified" }
  /** A newer click or a different action replaced this one. */
  | { status: "cancelled" };

/** A challenge that neither finishes nor asks for interaction must not hold up a sign-in. */
const SOCIAL_CHALLENGE_TIMEOUT_MS = 30_000;

/**
 * The signup challenge a Google or GitHub click runs before it starts the
 * provider login, because that login may create an account. It runs
 * invisibly; only when Cloudflare asks for interaction does the widget appear
 * where `element` is rendered, and the click continues once it is solved.
 */
export function useSocialSignupChallenge(siteKey: string | undefined): {
  element: ReactNode;
  interactive: boolean;
  run: () => Promise<SocialSignupChallengeOutcome>;
  cancel: () => void;
} {
  const container = useRef<HTMLDivElement>(null);
  const active = useRef<((outcome: SocialSignupChallengeOutcome) => void) | null>(null);
  const [interactive, setInteractive] = useState(false);
  const cancel = useCallback(() => active.current?.({ status: "cancelled" }), []);
  useEffect(() => {
    // Load the script early so a click doesn't also wait for the download.
    if (siteKey) void load().catch(() => undefined);
    return cancel;
  }, [siteKey, cancel]);
  const run = useCallback((): Promise<SocialSignupChallengeOutcome> => {
    active.current?.({ status: "cancelled" });
    if (!siteKey) return Promise.resolve({ status: "unverified" });
    return new Promise((resolve) => {
      let settled = false;
      let widget: string | undefined;
      let api: Turnstile | undefined;
      let timer: number | undefined;
      const settle = (outcome: SocialSignupChallengeOutcome) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (active.current === settle) active.current = null;
        setInteractive(false);
        try {
          if (widget !== undefined) api?.remove(widget);
        } catch {
          // The token, if any, is already in hand.
        }
        resolve(outcome);
      };
      const startTimer = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(
          () => settle({ status: "unverified" }),
          SOCIAL_CHALLENGE_TIMEOUT_MS,
        );
      };
      active.current = settle;
      startTimer();
      load()
        .then((turnstile) => {
          if (settled) return;
          if (!container.current) {
            settle({ status: "unverified" });
            return;
          }
          api = turnstile;
          widget = turnstile.render(container.current, {
            sitekey: siteKey,
            action: "signup",
            theme: "auto",
            execution: "execute",
            appearance: "interaction-only",
            retry: "never",
            callback: (token: string) => settle({ status: "verified", token }),
            "error-callback": () => {
              settle({ status: "unverified" });
              return true;
            },
            "unsupported-callback": () => settle({ status: "unverified" }),
            "before-interactive-callback": () => {
              if (settled) return;
              // A person is solving it now; wait for them, not the timer.
              window.clearTimeout(timer);
              setInteractive(true);
            },
            "after-interactive-callback": () => {
              if (settled) return;
              setInteractive(false);
              startTimer();
            },
          });
          turnstile.execute(widget);
        })
        .catch(() => settle({ status: "unverified" }));
    });
  }, [siteKey]);
  const element = siteKey ? (
    <div
      ref={container}
      aria-label="Signup verification"
      className={interactive ? "mt-3 flex justify-center" : undefined}
    />
  ) : null;
  return { element, interactive, run, cancel };
}

export function SignupChallenge({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string;
  onToken: (token: string | undefined) => void;
  resetKey?: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let widget: string | undefined;
    let api: Turnstile | undefined;
    callback.current(undefined);
    setFailed(false);
    void load()
      .then((turnstile) => {
        if (disposed || !element.current) return;
        api = turnstile;
        widget = turnstile.render(element.current, {
          sitekey: siteKey,
          action: "signup",
          theme: "auto",
          callback: (token: string) => {
            if (!disposed) callback.current(token);
          },
          "expired-callback": () => {
            if (!disposed) callback.current(undefined);
          },
          "error-callback": () => {
            if (!disposed) {
              callback.current(undefined);
              setFailed(true);
            }
          },
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [siteKey, retry, resetKey]);
  return (
    <div className="my-3">
      <div ref={element} aria-label="Signup verification" />
      {failed ? (
        <div role="alert" className="text-sm">
          Verification couldn't load.{" "}
          <Button type="button" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
