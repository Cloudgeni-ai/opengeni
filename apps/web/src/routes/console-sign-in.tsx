import { LayoutDashboardIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { authorizeConsoleSignIn } from "@/api";
import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import type { ConsoleSignInSearch } from "@/lib/console-sign-in";
import { useNativeSignInContext } from "@/lib/native-sign-in-context";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { userErrorText } from "@opengeni/react/ui/api-error";

/* ----------------------------------------------------------------------------
   /console-sign-in, on the app host: where Opengeni Console sends a person who
   is signed out on Console's own host. The app's ordinary sign-in runs first
   when needed (email, Google, GitHub, passkeys); signed in, this page asks for
   a one-time code and goes straight back to Console, which redeems it for its
   own session. Only the API decides where that is: a configured Console origin.
   -------------------------------------------------------------------------- */

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;

/** The redirect the API returned, only when it opens on the Console origin asked for. */
export function consoleSignInRedirect(redirectUrl: string, consoleOrigin: string): string | null {
  try {
    const url = new URL(redirectUrl);
    return url.origin === consoleOrigin && (url.protocol === "https:" || url.protocol === "http:")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function ConsoleSignInRoute({ search }: { search: ConsoleSignInSearch }) {
  const context = useNativeSignInContext();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const valid = Boolean(search.console && search.challenge && CHALLENGE.test(search.challenge));

  const handOff = useCallback(async () => {
    if (!search.console || !search.challenge) return;
    setError(null);
    try {
      const { redirectUrl } = await authorizeConsoleSignIn({
        consoleOrigin: search.console,
        returnPath: search.return ?? "/console",
        codeChallenge: search.challenge,
      });
      const target = consoleSignInRedirect(redirectUrl, search.console);
      if (!target) throw new Error("Opengeni Console's address didn't match.");
      // Replace: Back from Console never returns to this one-time page.
      window.location.replace(target);
    } catch (caught) {
      setError(userErrorText(caught, "Try again."));
    }
  }, [search.console, search.challenge, search.return]);

  useEffect(() => {
    if (!context || !valid || started.current) return;
    started.current = true;
    void handOff();
  }, [context, valid, handOff]);

  if (!context) return null;

  if (!valid) {
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<LayoutDashboardIcon />}
          title="Nothing to sign in here"
          description="Open Opengeni Console to sign in to it."
        />
      </ConsentFrame>
    );
  }

  if (error) {
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          tone="danger"
          icon={<LayoutDashboardIcon />}
          title="Couldn't open Opengeni Console"
          description={error}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => void handOff()}>
                Try again
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  // Sign-out returns home; come back here to sign in as
                  // someone else, and Console's sign-in continues.
                  const request = window.location.href;
                  void context.handleManagedSignOut().then(() => window.location.replace(request));
                }}
              >
                Use another account
              </Button>
            </div>
          }
        />
      </ConsentFrame>
    );
  }

  return (
    <ConsentFrame>
      <EmptyState
        variant="page"
        icon={<Loader2Icon className="animate-spin" />}
        title="Opening Opengeni Console"
        description={`Signed in as ${context.email}`}
      />
    </ConsentFrame>
  );
}
