import { useEffect, useRef, useState } from "react";
import { Button } from "@opengeni/react/ui/button";

type Turnstile = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
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
