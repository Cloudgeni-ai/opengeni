import { useState } from "react";
import { PersonalSettingsShell } from "@/components/settings/personal-settings-shell";
import { SignInMethodsView, type SignInMethodView } from "@/components/sign-in-methods";

/** Local-only visual fixtures; no credentials, real provider calls, or auth claims. */
export function SignInMethodsPreview() {
  const params = new URLSearchParams(window.location.search);
  const [recentAuthRequired, setRecentAuthRequired] = useState(params.get("state") === "reauth");
  const [hasPassword, setHasPassword] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [methods, setMethods] = useState<SignInMethodView[]>([
    {
      provider: "google",
      connected: true,
      available: true,
      email: "alex.morgan@example.com",
      handle: null,
      canDisconnect: false,
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
  ]);
  function protect(next: SignInMethodView[], password: boolean) {
    const count =
      next.filter((method) => method.connected && method.available).length + Number(password);
    return next.map((method) => ({ ...method, canDisconnect: count > 1 }));
  }
  return (
    <PersonalSettingsShell email="alex.morgan@example.com">
      <p className="mb-4 text-xs text-fg-subtle">
        LOCAL PREVIEW · All changes below are simulated.
      </p>
      <SignInMethodsView
        methods={methods}
        hasPassword={hasPassword}
        passwordAvailable
        busy={false}
        recentAuthRequired={recentAuthRequired}
        error={
          params.get("state") === "error"
            ? "This provider account is already connected to another OpenGeni account. Accounts are not merged."
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
