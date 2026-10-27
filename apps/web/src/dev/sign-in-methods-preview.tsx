import { useState } from "react";
import { PersonalSettingsShell } from "@/components/settings/personal-settings-shell";
import {
  SignInMethodsView,
  type PasskeysView,
  type SignInMethodView,
} from "@/components/sign-in-methods";

const previewPasskeys: PasskeysView["items"] = [
  {
    id: "preview-passkey-1",
    name: "Password manager",
    createdAt: "2026-09-02T10:00:00Z",
    lastUsedAt: "2026-10-20T08:30:00Z",
    backedUp: true,
  },
];

/** Local-only visual fixtures; no credentials, real provider calls, or auth claims. */
export function SignInMethodsPreview() {
  const params = new URLSearchParams(window.location.search);
  // `?passkeys=1` adds the Passkeys section; `?passkeys=only` previews an account
  // that signs in with passkeys alone (no email address, password or providers).
  const passkeyMode = params.get("passkeys");
  const passkeysOnly = passkeyMode === "only";
  const [passkeys, setPasskeys] = useState(previewPasskeys);
  const [recentAuthRequired, setRecentAuthRequired] = useState(params.get("state") === "reauth");
  const [hasPassword, setHasPassword] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [methods, setMethods] = useState<SignInMethodView[]>(
    passkeysOnly
      ? []
      : [
          {
            provider: "google",
            connected: true,
            available: true,
            email: "alex.morgan@example.com",
            handle: null,
            canDisconnect: passkeyMode !== null,
            reconnectRequired: false,
          },
          {
            provider: "github",
            connected: false,
            available: params.get("state") !== "unavailable",
            email: null,
            handle: null,
            canDisconnect: false,
            reconnectRequired: true,
          },
        ],
  );
  function protect(next: SignInMethodView[], password: boolean) {
    const count =
      next.filter((method) => method.connected && method.available).length +
      Number(password) +
      Number(passkeyMode !== null && passkeys.length > 0);
    return next.map((method) => ({ ...method, canDisconnect: count > 1 }));
  }
  return (
    <PersonalSettingsShell email={passkeysOnly ? "Passkey account" : "alex.morgan@example.com"}>
      <p className="mb-4 text-xs text-fg-subtle">
        LOCAL PREVIEW · All changes below are simulated.
      </p>
      <SignInMethodsView
        methods={methods}
        hasPassword={hasPassword}
        passwordAvailable
        showPassword={!passkeysOnly}
        passkeys={
          passkeyMode
            ? {
                items: passkeys,
                available: true,
                supported: true,
                canRemove: passkeysOnly ? passkeys.length > 1 : true,
                onlyMethod: passkeysOnly,
              }
            : null
        }
        onAddPasskey={() => {
          setPasskeys((current) => [
            ...current,
            {
              id: `preview-passkey-${current.length + 1}`,
              name: current.length === 0 ? "Password manager" : "Security key",
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              backedUp: false,
            },
          ]);
          setSuccess("Preview: passkey added.");
        }}
        onRemovePasskey={async (passkeyId) => {
          setPasskeys((current) => current.filter((passkey) => passkey.id !== passkeyId));
          setSuccess("Preview: passkey removed.");
          return true;
        }}
        busy={false}
        recentAuthRequired={recentAuthRequired}
        error={
          params.get("state") === "error"
            ? "This provider account is already connected to another Opengeni account. Accounts are not merged."
            : null
        }
        success={success}
        onReauthenticate={() => {
          setRecentAuthRequired(false);
          setSuccess("Preview: authentication confirmed. Review and retry your change.");
        }}
        onConnect={(provider) => {
          setMethods((current) =>
            protect(
              current.map((method) =>
                method.provider === provider
                  ? {
                      ...method,
                      connected: true,
                      email: "alex.morgan@example.com",
                      handle: "@alexmorgan",
                      reconnectRequired: false,
                    }
                  : method,
              ),
              hasPassword,
            ),
          );
          setSuccess("Preview: sign-in method connected.");
        }}
        onDisconnect={async (provider) => {
          setMethods((current) =>
            protect(
              current.map((method) =>
                method.provider === provider
                  ? { ...method, connected: false, reconnectRequired: true }
                  : method,
              ),
              hasPassword,
            ),
          );
          setSuccess("Preview: sign-in method disconnected.");
          return true;
        }}
        onPassword={async () => {
          setHasPassword(true);
          setMethods((current) => protect(current, true));
          setSuccess("Preview: password saved.");
          return true;
        }}
      />
    </PersonalSettingsShell>
  );
}
