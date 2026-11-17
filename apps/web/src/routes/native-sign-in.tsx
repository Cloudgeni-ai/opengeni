import { CheckCircle2Icon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Field, TextInput } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { type NativeSignInSearch, useNativeSignInContext } from "@/lib/native-sign-in-context";

/* ----------------------------------------------------------------------------
   /native-sign-in: the page the Opengeni phone app opens in the system auth
   browser. The person signs in here with any web method, then allows this
   device. Allow hands the app a one-time code bound to its PKCE challenge;
   the app redeems it for its own credential, which it can sign out alone.
   -------------------------------------------------------------------------- */

/** The Office add-in's callback page, on this same web origin. */
export const OFFICE_ADDIN_CALLBACK_PATH = "/office/auth-callback.html";

/**
 * Only an app callback (`<scheme>://auth/callback`) or the Office add-in's
 * callback page on this very origin is ever navigated to.
 */
export function nativeCallbackUrl(
  redirectUri: string | undefined,
  origin: string | undefined = globalThis.location?.origin,
): URL | null {
  if (origin && redirectUri === `${origin}${OFFICE_ADDIN_CALLBACK_PATH}`) {
    return new URL(redirectUri);
  }
  if (!redirectUri || !/^[a-z][a-z0-9+.-]*:\/\/auth\/callback$/u.test(redirectUri)) return null;
  const url = new URL(redirectUri);
  return ["http:", "https:", "javascript:", "data:", "file:"].includes(url.protocol) ? null : url;
}

export function nativeDeviceLabel(search: NativeSignInSearch): string {
  const name = search.device_name?.trim();
  if (name) return name;
  switch (search.platform) {
    case "android":
      return "this Android device";
    case "macos":
      return "this Mac";
    case "windows":
    case "linux":
      return "this computer";
    case "office":
      return "the Opengeni add-in in Excel";
    default:
      return "this iPhone or iPad";
  }
}

function appName(search: NativeSignInSearch): string {
  return search.platform === "office" ? "add-in" : "app";
}

function UseAnotherAccount({ signOut }: { signOut: () => Promise<void> }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        // Sign-out returns home; come back to this request to sign in
        // as someone else, so the app's sign-in continues.
        const request = window.location.href;
        void signOut().then(() => window.location.replace(request));
      }}
    >
      Use another account
    </Button>
  );
}

/**
 * A relayed sign-in (the Excel add-in on desktop Office, which opened this
 * page in the person's browser). The app shows a short code; typing it here
 * proves this browser is approving the app the person is looking at, not a
 * request someone else made and sent them a link to.
 */
export function NativeRelaySignIn({
  search,
  relayId,
  email,
  approve,
  signOut,
}: {
  search: NativeSignInSearch;
  relayId: string;
  email: string;
  approve: (input: { relayId: string; confirmationCode: string }) => Promise<void>;
  signOut: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<"approved" | "cancelled" | null>(null);
  const app = appName(search);
  const where = search.platform === "office" ? "Excel" : "the app";
  if (outcome) {
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={outcome === "approved" ? <CheckCircle2Icon /> : <SmartphoneIcon />}
          title={outcome === "approved" ? `You're signed in to the ${app}` : "Sign-in cancelled"}
          description={
            outcome === "approved"
              ? `Go back to ${where}. You can close this tab.`
              : "You can close this tab."
          }
        />
      </ConsentFrame>
    );
  }
  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<SmartphoneIcon />} />}
        title={`Sign in to the Opengeni ${app}`}
        description={`Allow only if you started this sign-in in ${where}. The ${app} acts as you, and you can sign it out at any time.`}
        submitLabel="Allow"
        pendingLabel="Signing in…"
        submitDisabled={code.trim().length === 0}
        onCancel={() => setOutcome("cancelled")}
        footerStart={<UseAnotherAccount signOut={signOut} />}
        onSubmit={async () => {
          try {
            await approve({ relayId, confirmationCode: code });
            setOutcome("approved");
          } catch (caught) {
            throw new Error(userErrorText(caught, "Try again."), { cause: caught });
          }
        }}
      >
        <Field label={`Code shown in ${where}`}>
          <TextInput
            value={code}
            onChange={(event) => setCode(event.target.value)}
            mono
            suppressAutofill
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            data-autofocus
            className="tracking-widest uppercase"
          />
        </Field>
        <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
          <dt className="text-fg-muted">Account</dt>
          <dd className="truncate text-fg">{email}</dd>
          <dt className="text-fg-muted">Device</dt>
          <dd className="truncate text-fg">{nativeDeviceLabel(search)}</dd>
        </dl>
      </FormPage>
    </ConsentFrame>
  );
}

export function NativeSignInRoute({ search }: { search: NativeSignInSearch }) {
  const context = useNativeSignInContext();
  const [leaving, setLeaving] = useState(false);
  const callback = nativeCallbackUrl(search.redirect_uri);
  if (!context) return null;
  const { client, email, handleManagedSignOut } = context;

  if (search.relay && search.platform) {
    return (
      <NativeRelaySignIn
        search={search}
        relayId={search.relay}
        email={email}
        approve={(input) => client.approveNativeAppRelay(input)}
        signOut={handleManagedSignOut}
      />
    );
  }

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
        title={
          search.platform === "office"
            ? "Sign in to the Opengeni add-in"
            : "Sign in to the Opengeni app"
        }
        description={
          search.platform === "office"
            ? "The add-in acts as you, never with more than you can do. Sign it out from the add-in at any time."
            : "The app acts as you, never with more than you can do. Sign it out from the app at any time."
        }
        submitLabel="Allow"
        pendingLabel="Signing in…"
        pending={leaving}
        onCancel={cancel}
        footerStart={<UseAnotherAccount signOut={handleManagedSignOut} />}
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
