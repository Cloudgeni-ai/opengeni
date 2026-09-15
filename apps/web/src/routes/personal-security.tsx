import { useBrowserAccounts } from "@opengeni/react/accounts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { PersonalSettingsShell } from "@/components/settings/personal-settings-shell";
import { SignInMethodsView, providerLabel } from "@/components/sign-in-methods";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";
import { usePersonalSecurityContext } from "@/lib/personal-security-context";
import {
  clearSignInChangeFeedback,
  readSignInChangeFeedback,
  retainSignInChangeFeedback,
  signInCallbackError,
  securityReauthenticationPath,
} from "@/lib/sign-in-feedback";
import {
  createSignInMethodsApi,
  type PreparedSignInCommand,
  type SignInChangeResult,
  type SignInCommand,
  type SignInMethods,
} from "@/lib/sign-in-methods-api";
import { signInMethodFailure } from "@/lib/sign-in-method-failure";

export function PersonalSecurityRoute() {
  const context = usePersonalSecurityContext();
  if (!context || context.clientConfig.auth.mode !== "managedSession") {
    return (
      <ProblemPanel
        title="Sign-in methods unavailable"
        description="Personal sign-in methods are managed by OpenGeni only on deployments with managed browser sign-in."
      />
    );
  }
  const mode = context.clientConfig.managedAuthSessionSetMode ?? "dual";
  return mode === "legacy" ? (
    <LegacySecurity key={`${context.authSession.user.id}:${context.accessKeyVersion}`} />
  ) : (
    <BrokerSecurity key={`${context.authSession.user.id}:${context.accessKeyVersion}`} />
  );
}

function LegacySecurity() {
  const context = usePersonalSecurityContext()!;
  const [reauthError, setReauthError] = useState<string | null>(null);
  return (
    <SecurityController
      mode="legacy"
      userId={context.authSession!.user.id}
      email={context.authSession!.user.email}
      reauthError={reauthError}
      onReauthenticate={() => {
        const returnPath = securityReauthenticationPath(window.location.search);
        // Sign out through the root's established principal transition before
        // presenting login. Never replace a managed cookie behind its back.
        void context
          .handleManagedSignOut()
          .then(() => window.location.assign(returnPath))
          .catch(() =>
            setReauthError(
              "Couldn't finish signing out. Try again before continuing with reauthentication.",
            ),
          );
      }}
    />
  );
}
function BrokerSecurity() {
  const context = usePersonalSecurityContext()!;
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const [reauthError, setReauthError] = useState<string | null>(null);
  return (
    <SecurityController
      mode={context.clientConfig.managedAuthSessionSetMode ?? "dual"}
      userId={context.authSession!.user.id}
      email={context.authSession!.user.email}
      reauthError={reauthError}
      onReauthenticate={() => {
        const slotId = accounts.projection?.selectedSlotId;
        if (!slotId) {
          setReauthError(
            "Select the account you want to manage, then open Personal settings again.",
          );
          return;
        }
        setReauthError(null);
        popup.open(() => accounts.beginReauth(slotId), {
          onError: () =>
            setReauthError("Couldn't open sign-in. Allow popups for OpenGeni and try again."),
          onSettled: () => context.revalidatePrincipalAccess(),
        });
      }}
    />
  );
}

export function SecurityController({
  mode,
  userId,
  email,
  onReauthenticate,
  reauthError,
  api: suppliedApi,
}: {
  mode: "legacy" | "dual" | "broker";
  userId: string;
  email: string;
  onReauthenticate: () => void;
  reauthError?: string | null;
  api?: ReturnType<typeof createSignInMethodsApi>;
}) {
  const api = useMemo(
    () => suppliedApi ?? createSignInMethodsApi(mode),
    [mode, suppliedApi, userId],
  );
  const live = useRef(false);
  const owner = useRef(userId);
  const lifecycle = useRef(0);
  const [inventory, setInventory] = useState<SignInMethods | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [uncertain, setUncertain] = useState<PreparedSignInCommand | null>(null);
  const [revision, setRevision] = useState(0);
  const [committed, setCommitted] = useState(false);
  const isCurrent = useCallback(() => live.current && owner.current === userId, [userId]);
  useEffect(() => {
    live.current = true;
    owner.current = userId;
    lifecycle.current += 1;
    let active = true;
    setInventory(null);
    setError(null);
    void api
      .list()
      .then((result) => {
        if (!active || !isCurrent()) return;
        setInventory(result);
        setRequiresAuth(result.freshAuthenticationRequired);
        const receipt = readSignInChangeFeedback();
        if (receipt?.userId === userId && !result.freshAuthenticationRequired) {
          setSuccess(receipt.message);
          clearSignInChangeFeedback();
        }
        const callback = new URLSearchParams(window.location.search).get("signInMethod");
        if (callback === "connected") {
          const usable = result.methods
            .filter((method) => method.connected && method.available)
            .map((method) =>
              method.provider === "credential"
                ? "email and password"
                : providerLabel(method.provider),
            );
          setSuccess(
            usable.length
              ? `Sign-in methods confirmed: ${usable.join(", ")}. You can use these to access your OpenGeni account.`
              : "The provider returned to OpenGeni, but no usable sign-in method was confirmed. Review the methods below before continuing.",
          );
        }
        if (callback === "error")
          setError(
            signInCallbackError(
              new URLSearchParams(window.location.search).get("error") ?? "unknown",
            ),
          );
      })
      .catch(() => {
        if (active && isCurrent())
          setError(
            "Couldn't load your sign-in methods. Try refreshing, or sign in again if your session expired.",
          );
      });
    return () => {
      active = false;
      live.current = false;
      lifecycle.current += 1;
    };
  }, [api, isCurrent, revision, userId]);

  async function execute(
    command: PreparedSignInCommand,
    acceptedLifecycle = lifecycle.current,
  ): Promise<boolean> {
    try {
      const result = await api.execute<SignInChangeResult | { url: string }>(command);
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      setUncertain(null);
      if ("url" in result) {
        const target = new URL(result.url, window.location.origin);
        if (target.protocol !== "https:" && target.origin !== window.location.origin)
          throw new Error("Invalid provider redirect");
        window.location.assign(target.href);
        return true;
      }
      const changed =
        command.path === "password"
          ? "Your password was saved."
          : `${providerLabel((command.body as { provider: "google" | "github" }).provider)} was disconnected from sign-in.`;
      const notification =
        result.notification === "sent"
          ? ""
          : " The change succeeded, but the security notification could not be confirmed as delivered.";
      const message = `${changed}${notification} Sign in again as ${email} with a remaining sign-in method to continue.`;
      retainSignInChangeFeedback({ userId, email, message: `${changed}${notification}` });
      setSuccess(message);
      setRequiresAuth(true);
      setCommitted(true);
      setError(null);
      return true;
    } catch (caught) {
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      const failure = signInMethodFailure(caught);
      if (failure.kind !== "unknown") {
        setUncertain(null);
        if (failure.kind === "reauth") setRequiresAuth(true);
      } else {
        // Keep the exact body, UUID, revision and admission headers in memory
        // only. A transport failure is not proof the mutation failed.
        setUncertain(command);
      }
      setError(failure.message);
      return false;
    }
  }
  async function mutate(
    path: PreparedSignInCommand["path"],
    fields: { provider: "google" | "github" } | { newPassword: string; currentPassword?: string },
  ) {
    if (!inventory || inFlight.current || requiresAuth || uncertain) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const acceptedLifecycle = lifecycle.current;
    try {
      const body: SignInCommand = {
        operationId: crypto.randomUUID(),
        expectedIdentityRevision: inventory.identityRevision,
        ...fields,
      };
      const command = await api.prepare(path, body);
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      return await execute(command, acceptedLifecycle);
    } catch {
      if (isCurrent() && acceptedLifecycle === lifecycle.current)
        setError("Couldn't prepare this change. Refresh your methods and try again.");
      return false;
    } finally {
      if (isCurrent() && acceptedLifecycle === lifecycle.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  const password = inventory?.methods.find((method) => method.provider === "credential");
  return (
    <PersonalSettingsShell email={inventory?.email ?? email}>
      {committed ? (
        <div className="grid gap-4">
          <h1 className="text-xl font-semibold">Sign-in methods updated</h1>
          <div role="status">
            <Notice tone="success">{success}</Notice>
          </div>
          {reauthError ? (
            <div role="alert">
              <Notice tone="failed">{reauthError}</Notice>
            </div>
          ) : null}
          <Button className="min-h-11 justify-self-start" onClick={onReauthenticate}>
            Sign in again
          </Button>
        </div>
      ) : !inventory ? (
        error ? (
          <Notice tone="failed" title="Couldn't load sign-in methods">
            {error}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
                Retry
              </Button>
              <Button variant="ghost" onClick={onReauthenticate}>
                Sign in again
              </Button>
            </div>
          </Notice>
        ) : (
          <LoadingPanel label="Loading sign-in methods" />
        )
      ) : (
        <>
          <SignInMethodsView
            methods={inventory.methods
              .filter((method) => method.provider !== "credential")
              .map((method) => ({
                provider: method.provider as "google" | "github",
                connected: method.connected,
                available: method.available,
                email: method.connected ? inventory.email : null,
                emailLabel: "Connected · OpenGeni account: ",
                handle: null,
                canDisconnect: method.canDisconnect,
                reconnectRequired: method.implicitRelinkingSuppressed,
              }))}
            hasPassword={password?.connected ?? false}
            passwordAvailable={password?.available ?? false}
            busy={busy}
            mutationLocked={uncertain !== null}
            recentAuthRequired={requiresAuth}
            error={reauthError ?? error}
            success={success}
            onReauthenticate={onReauthenticate}
            onConnect={(provider) => {
              void mutate("connect", { provider });
            }}
            onDisconnect={(provider) => mutate("disconnect", { provider })}
            onPassword={(newPassword, currentPassword) =>
              mutate("password", {
                newPassword,
                ...(currentPassword === undefined ? {} : { currentPassword }),
              })
            }
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {uncertain ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (inFlight.current) return;
                  inFlight.current = true;
                  setBusy(true);
                  void execute(uncertain).finally(() => {
                    if (isCurrent()) {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  });
                }}
              >
                Retry same request
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh sign-in methods
            </Button>
          </div>
        </>
      )}
    </PersonalSettingsShell>
  );
}
