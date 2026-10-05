import { SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { userErrorText } from "@/lib/api-error";
import { type NativeSignInSearch, useNativeSignInContext } from "@/lib/native-sign-in-context";

/* ----------------------------------------------------------------------------
   /native-sign-in: the page the Opengeni phone app opens in the system auth
   browser. The person signs in here with any web method, then allows this
   device. Allow hands the app a one-time code bound to its PKCE challenge;
   the app redeems it for its own credential, which it can sign out alone.
   -------------------------------------------------------------------------- */

/** Only an app callback (`<scheme>://auth/callback`) is ever navigated to. */
export function nativeCallbackUrl(redirectUri: string | undefined): URL | null {
  if (!redirectUri || !/^[a-z][a-z0-9+.-]*:\/\/auth\/callback$/u.test(redirectUri)) return null;
  const url = new URL(redirectUri);
  return ["http:", "https:", "javascript:", "data:", "file:"].includes(url.protocol) ? null : url;
}

export function nativeDeviceLabel(search: NativeSignInSearch): string {
  const name = search.device_name?.trim();
  if (name) return name;
  return search.platform === "android" ? "this Android device" : "this iPhone or iPad";
}

export function NativeSignInRoute({ search }: { search: NativeSignInSearch }) {
  const context = useNativeSignInContext();
  const [leaving, setLeaving] = useState(false);
  const callback = nativeCallbackUrl(search.redirect_uri);
  if (!context) return null;
  const { client, email, handleManagedSignOut } = context;

  if (!callback || !search.code_challenge || !search.platform) {
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<SmartphoneIcon />}
          title="Nothing to sign in here"
          description="Open this page from Sign in in the Opengeni app."
        />
      </ConsentFrame>
    );
  }

  const cancel = () => {
    const denied = new URL(callback);
    denied.searchParams.set("error", "access_denied");
    if (search.state) denied.searchParams.set("state", search.state);
    setLeaving(true);
    window.location.assign(denied.toString());
  };

  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<SmartphoneIcon />} />}
        title="Sign in to the Opengeni app"
        description="The app acts as you, never with more than you can do. Sign it out from the app at any time."
        submitLabel="Allow"
        pendingLabel="Signing in…"
        pending={leaving}
        onCancel={cancel}
        footerStart={
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // Sign-out returns home; come back to this request to sign in
              // as someone else, so the app's sign-in continues.
              const request = window.location.href;
              void handleManagedSignOut().then(() => window.location.replace(request));
            }}
          >
            Use another account
          </Button>
        }
        onSubmit={async () => {
          try {
            const { redirectUrl } = await client.authorizeNativeApp({
              redirectUri: callback.toString(),
              codeChallenge: search.code_challenge!,
              codeChallengeMethod: "S256",
              platform: search.platform!,
              ...(search.state ? { state: search.state } : {}),
              ...(search.device_name?.trim() ? { deviceName: search.device_name.trim() } : {}),
            });
            setLeaving(true);
            window.location.assign(redirectUrl);
            return false;
          } catch (caught) {
            throw new Error(`The app wasn't signed in. ${userErrorText(caught, "Try again.")}`, {
              cause: caught,
            });
          }
        }}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
          <dt className="text-fg-muted">Account</dt>
          <dd className="truncate text-fg">{email}</dd>
          <dt className="text-fg-muted">Device</dt>
          <dd className="truncate text-fg">{nativeDeviceLabel(search)}</dd>
        </dl>
      </FormPage>
    </ConsentFrame>
  );
}
