import { ArchiveConfirmationProvider } from "@opengeni/react/app/lib/archive-session";
import { AppContext } from "@opengeni/react/app/app-context";
import {
  createSlackLinkPrepareController,
  useAppState,
  type AppStateHost,
} from "@opengeni/react/app/app-state";
import { userErrorText } from "@opengeni/react/ui/api-error";
// Root providers: the web host of the shared app state (client config
// bootstrap, auth, workspace access and the cross-route console state), plus
// the web-only route gates: public pages, sign-in, onboarding and developer
// setup. Everything below the workspace shell consumes the state through
// `useAppContext`.
import { DESKTOP_APP_RETURN_PATH } from "@opengeni/contracts";
import { EXCEL_ADDIN_PATH } from "@/lib/excel-addin";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { CheckIcon, LockIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  clearStoredAccessKey,
  configureManagedActorEpoch,
  createOpenGeniClient,
  fetchAuthSession,
  fetchClientConfig,
  checkDeploymentRevision,
  mountApiUpdateNotice,
  getStoredAccessKey,
  setStoredAccessKey,
  signInEmail,
  signOutManaged,
  signUpEmail,
  startManagedSocialSignIn,
} from "@/api";
import { LoadingPanel, ProblemPanel, WaitingPanel } from "@opengeni/react/app/components/common";
import { DesktopSignedOutRecovery } from "@/components/desktop/desktop-signed-out";
import { SecureContextWarning } from "@/components/secure-context-warning";
import { Button } from "@opengeni/react/ui/button";
import { SignInCallbackNotice } from "@/components/sign-in-callback-notice";
import { NativeSignInProvider } from "@/lib/native-sign-in-context";
import { PersonalSecurityProvider } from "@/lib/personal-security-context";
import { Input } from "@opengeni/react/ui/input";
import { Label } from "@opengeni/react/ui/label";
import { Toaster } from "@opengeni/react/app/components/toaster";
import type { AnalyticsEventName, AnalyticsProperties } from "@/lib/analytics";
import {
  clearOrganizationInvitationContinuation,
  readOrganizationInvitationContinuation,
} from "@/lib/organization-invitation-continuation";
import { CreditRequiredGate } from "@opengeni/react/app/components/credit-required-gate";
import type { PendingSlackLink } from "@opengeni/react/app/app-context";
import type { ClientConfig, SlackUserLinkAccessRequest } from "@opengeni/react/app/types";
import {
  clearPendingDeveloperSetup,
  pendingDeveloperSetupFor,
} from "@/lib/pending-developer-setup";

export {
  createSlackLinkPrepareController,
  preserveSlackLinkForManagedAuth,
  type SlackLinkPreparePhase,
} from "@opengeni/react/app/app-state";

const AnalyticsManager = lazy(() =>
  import("@/components/analytics-consent").then((module) => ({
    default: module.AnalyticsManager,
  })),
);

const OrganizationOnboardingPanel = lazy(() =>
  import("@/components/organization-onboarding-panel").then((module) => ({
    default: module.OrganizationOnboardingPanel,
  })),
);
const ResumedDeveloperSetup = lazy(() =>
  import("@/components/organization-onboarding-panel").then((module) => ({
    default: module.ResumedDeveloperSetup,
  })),
);

const ManagedAuthPanel = lazy(() =>
  import("@/components/managed-auth-panel").then((module) => ({
    default: module.ManagedAuthPanel,
  })),
);

const SignedOutPage = lazy(() =>
  import("@/components/signed-out-page").then((module) => ({
    default: module.SignedOutPage,
  })),
);

const BrowserAccountsRuntime = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsRuntime,
  })),
);

const BrowserAccountsSignedOutPanel = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsSignedOutPanel,
  })),
);

const BrowserAccountsLoadingGate = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsLoadingGate,
  })),
);

const BrowserAccountsOrganizationOnboardingPanel = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsOrganizationOnboardingPanel,
  })),
);

function captureProductAnalyticsEvent(
  name: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): void {
  void import("@/lib/analytics").then(({ captureAnalyticsEvent }) => {
    captureAnalyticsEvent(name, properties);
  });
}

// Capture and scrub the signed fragment while this module is loading, before
// TanStack Router canonicalizes the initial location. The module-scoped
// controller survives Root/provider remounts, but releases the raw bearer as
// soon as exactly one prepare request has been created.
const bootstrappedPendingSlackLink = pendingSlackLinkFromBrowserLocation();
const bootstrappedInvalidSlackLinkQueryWorkspaceId =
  typeof window === "undefined"
    ? null
    : invalidSlackLinkQueryWorkspaceIdFromUrl(window.location.href);
stripSlackLinkFromBrowserLocation();

const webAppStateHost: AppStateHost = {
  authority: "app",
  createOpenGeniClient,
  fetchClientConfig,
  captureProductEvent: captureProductAnalyticsEvent,
  checkDeploymentRevision,
  fetchAuthSession,
  signInEmail,
  signUpEmail,
  signOutManaged,
  startManagedSocialSignIn,
  configureManagedActorEpoch,
  getStoredAccessKey,
  setStoredAccessKey,
  clearStoredAccessKey,
  slackLink: createSlackLinkPrepareController<SlackUserLinkAccessRequest>(
    bootstrappedPendingSlackLink,
  ),
  initialInvalidSlackLinkQueryWorkspaceId: bootstrappedInvalidSlackLinkQueryWorkspaceId,
};

export function RootRouteComponent() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const hasSearchParameters = useRouterState({
    select: (state) => Object.keys(state.location.search).length > 0,
  });
  const analyticsSearch = useRouterState({ select: (state) => state.location.searchStr });
  // Public surfaces render ahead of auth/config gates. `/reset-password` is
  // always public; DEV visual harnesses are public and need no session.
  const isPublicDevHarness =
    import.meta.env.DEV &&
    (pathname === "/dev/composer-chrome" ||
      pathname === "/dev/composer-stack" ||
      pathname === "/dev/onboarding" ||
      pathname === "/dev/session-timeline" ||
      pathname === "/dev/ui-kit");
  const isPublicAuthRoute =
    pathname === "/reset-password" ||
    pathname === "/setup-account" ||
    pathname === "/account-auth" ||
    pathname === EXCEL_ADDIN_PATH ||
    pathname === DESKTOP_APP_RETURN_PATH ||
    isPublicDevHarness;
  const {
    appContext,
    client,
    clientConfig,
    configError,
    retryClientConfig,
    authSession,
    accessContext,
    accessError,
    accessLoading,
    accessKeyVersion,
    retryAccess,
    keyAuthRequired,
    hasAccessKey,
    accessKeyDraft,
    setAccessKeyDraft,
    saveAccessKey,
    managedAuthRequired,
    managedEmailVerificationRequired,
    managedNewSignupsEnabled,
    managedSocialProviders,
    browserAccountsConfigured,
    browserAccountsEnabled,
    handleManagedAuth,
    handleManagedSessionSetSignup,
    handleManagedSocialAuth,
    handleManagedSignOut,
    handleBrowserActorTransition,
    completeOrganizationOnboarding,
    revalidatePrincipalAccess,
    defaultWorkspaceId,
    slackLinkContinuationWorkspaceId,
    routedWorkspace,
    creditRequired,
    setCreditRequired,
    mutationBusy,
  } = useAppState(webAppStateHost, { bootstrapSuspended: isPublicDevHarness });
  // "Add AI agents to my product" left its developer setup step unfinished
  // (reload, closed tab, another device): show it again until it is done.
  const [developerSetupRevision, setDeveloperSetupRevision] = useState(0);
  const pendingDeveloperSetup = useMemo(
    () => (managedAuthRequired ? pendingDeveloperSetupFor(authSession?.user.email ?? null) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-read after the step finishes
    [managedAuthRequired, authSession?.user.email, developerSetupRevision],
  );
  const organizationInvitationContinuation = managedAuthRequired
    ? readOrganizationInvitationContinuation()
    : null;

  const applicationSurface = isPublicAuthRoute ? (
    // Self-contained public pages render before config/auth gates and outside
    // AppContext. The isolated account-auth popup is intentionally included.
    <Outlet />
  ) : !clientConfig && !configError ? (
    <LoadingPanel />
  ) : configError?.recovering ? (
    // An update or dropped connection: startup continues by itself.
    <WaitingPanel
      title={configError.title}
      description={configError.description}
      action={
        <Button type="button" variant="ghost" size="sm" onClick={retryClientConfig}>
          Try again
        </Button>
      }
    />
  ) : configError ? (
    <ProblemPanel
      title={configError.title}
      description={configError.description}
      action={
        <Button type="button" variant="outline" onClick={retryClientConfig}>
          Try again
        </Button>
      }
    />
  ) : keyAuthRequired && !hasAccessKey ? (
    <AccessKeyPanel
      authMode={clientConfig?.auth.mode}
      accessKeyDraft={accessKeyDraft}
      setAccessKeyDraft={setAccessKeyDraft}
      onSubmit={saveAccessKey}
    />
  ) : managedAuthRequired && authSession === undefined ? (
    <LoadingPanel />
  ) : managedAuthRequired && !authSession ? (
    <DesktopSignedOutRecovery>
      <Suspense fallback={<LoadingPanel />}>
        <SignedOutPage legalLinks={clientConfig?.legal} supportEmail={clientConfig?.supportEmail}>
          {browserAccountsEnabled ? (
            <BrowserAccountsSignedOutPanel
              presentation="embedded"
              search={window.location.search}
              invitation={organizationInvitationContinuation}
              emptySetRegistrationPanel={
                clientConfig?.managedAuthSessionSetMode === "broker" ||
                clientConfig?.managedAuthSessionSetMode === "dual" ? (
                  <ManagedAuthPanel
                    initialMode="signup"
                    allowedModes={["signup"]}
                    presentation="embedded"
                    onSubmit={async (_mode, input) => await handleManagedSessionSetSignup(input)}
                    emailVerificationRequired={managedEmailVerificationRequired}
                    newSignupsEnabled={managedNewSignupsEnabled}
                  />
                ) : undefined
              }
            />
          ) : (
            <ManagedAuthPanel
              presentation="embedded"
              search={window.location.search}
              invitation={organizationInvitationContinuation}
              onDismissInvitation={clearOrganizationInvitationContinuation}
              onSubmit={handleManagedAuth}
              emailVerificationRequired={managedEmailVerificationRequired}
              newSignupsEnabled={managedNewSignupsEnabled}
              socialProviders={managedSocialProviders}
              onSocialSubmit={handleManagedSocialAuth}
            />
          )}
        </SignedOutPage>
      </Suspense>
    </DesktopSignedOutRecovery>
  ) : /^\/(?:native-sign-in|site-auth\/authorize)\/?$/.test(pathname) &&
    managedAuthRequired &&
    authSession &&
    clientConfig ? (
    // A phone app, and a published Site's viewer, are signed in by the person,
    // not by a workspace grant (an invited viewer may belong to no
    // organization), so approval renders before the access and onboarding gates.
    browserAccountsConfigured && !browserAccountsEnabled ? (
      <LoadingPanel />
    ) : (
      <NativeSignInProvider value={{ client, email: authSession.user.email, handleManagedSignOut }}>
        <Outlet />
      </NativeSignInProvider>
    )
  ) : /^\/settings\/security\/?$/.test(pathname) &&
    managedAuthRequired &&
    authSession &&
    clientConfig ? (
    // Personal security requires the selected managed human, never a workspace
    // grant. Keep this after authentication but before access/onboarding gates.
    // The outer BrowserAccountsRuntime still owns broker actor transitions.
    browserAccountsConfigured && !browserAccountsEnabled ? (
      <LoadingPanel />
    ) : (
      <PersonalSecurityProvider
        value={{
          clientConfig,
          authSession,
          accessKeyVersion,
          handleManagedSignOut,
          revalidatePrincipalAccess,
        }}
      >
        <Outlet />
      </PersonalSecurityProvider>
    )
  ) : accessError?.recovering ? (
    <WaitingPanel
      title={accessError.title}
      description={accessError.description}
      action={
        <Button type="button" variant="ghost" size="sm" onClick={retryAccess}>
          Try again
        </Button>
      }
    />
  ) : accessError && !accessLoading ? (
    <ProblemPanel
      title={accessError.title}
      description={accessError.description}
      action={
        <Button type="button" variant="outline" onClick={retryAccess}>
          Retry
        </Button>
      }
    />
  ) : managedAuthRequired &&
    clientConfig &&
    !accessLoading &&
    accessContext &&
    !defaultWorkspaceId &&
    !slackLinkContinuationWorkspaceId ? (
    browserAccountsEnabled ? (
      <BrowserAccountsOrganizationOnboardingPanel
        client={client}
        billingMode={clientConfig.billingMode ?? "disabled"}
        codexEnabled={clientConfig.models.some((catalogModel) => catalogModel.source === "codex")}
        supergrokEnabled={clientConfig.models.some(
          (catalogModel) => catalogModel.source === "supergrok",
        )}
        modelDefaults={clientConfig}
        activeEmail={authSession?.user.email ?? null}
        invitation={organizationInvitationContinuation}
        onComplete={completeOrganizationOnboarding}
      />
    ) : (
      <Suspense fallback={<LoadingPanel />}>
        <OrganizationOnboardingPanel
          client={client}
          billingMode={clientConfig.billingMode ?? "disabled"}
          codexEnabled={clientConfig.models.some((catalogModel) => catalogModel.source === "codex")}
          supergrokEnabled={clientConfig.models.some(
            (catalogModel) => catalogModel.source === "supergrok",
          )}
          modelDefaults={clientConfig}
          activeEmail={authSession?.user.email ?? null}
          invitation={organizationInvitationContinuation}
          onUseInvitedAccount={() => {
            void handleManagedSignOut().catch((error) =>
              toast.error("Sign out failed", { description: userErrorText(error) }),
            );
          }}
          onSignOut={handleManagedSignOut}
          onComplete={completeOrganizationOnboarding}
        />
      </Suspense>
    )
  ) : accessLoading || !appContext ? (
    <LoadingPanel />
  ) : !defaultWorkspaceId && !slackLinkContinuationWorkspaceId ? (
    <ProblemPanel
      title="No workspace access"
      description="You don't have access to any workspace yet."
    />
  ) : pendingDeveloperSetup &&
    accessContext?.accountGrants.some(
      (grant) => grant.accountId === pendingDeveloperSetup.organizationId,
    ) ? (
    <Suspense fallback={<LoadingPanel />}>
      <ResumedDeveloperSetup
        client={client}
        organizationId={pendingDeveloperSetup.organizationId}
        organizationName={pendingDeveloperSetup.organizationName}
        activeEmail={authSession?.user.email ?? null}
        onSignOut={handleManagedSignOut}
        onComplete={(destination) => {
          clearPendingDeveloperSetup();
          // Reach the destination before the app's routes return: the home
          // route would otherwise redirect to the landing workspace first.
          void completeOrganizationOnboarding(destination).finally(() =>
            setDeveloperSetupRevision((revision) => revision + 1),
          );
        }}
      />
    </Suspense>
  ) : (
    <AppContext.Provider value={appContext}>
      <ArchiveConfirmationProvider>
        <Outlet />
        <CreditRequiredGate
          creditRequired={creditRequired}
          setCreditRequired={setCreditRequired}
          accessContext={accessContext}
        />
        {import.meta.env.DEV && import.meta.env.VITE_OPENGENI_ROUTER_DEVTOOLS === "true" ? (
          <TanStackRouterDevtools position="bottom-right" />
        ) : null}
      </ArchiveConfirmationProvider>
    </AppContext.Provider>
  );

  const actorFencedSurface =
    browserAccountsEnabled && !isPublicAuthRoute ? (
      <Suspense fallback={<LoadingPanel />}>
        <BrowserAccountsRuntime
          bootstrapLegacySession={
            clientConfig?.managedAuthSessionSetMode === "dual" && Boolean(authSession)
          }
          mutationBusy={mutationBusy}
          onActorTransition={handleBrowserActorTransition}
        >
          <BrowserAccountsLoadingGate>{applicationSurface}</BrowserAccountsLoadingGate>
        </BrowserAccountsRuntime>
      </Suspense>
    ) : (
      applicationSurface
    );

  return (
    // Fixed app canvas: never let the document scroll. Page surfaces own
    // overflow via ContentPage / session panes. `min-h-screen` used to let
    // main grow past the viewport when a child mis-owned scroll.
    <main className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <Toaster />
      <div ref={mountApiUpdateNotice} className="shrink-0" />
      <SignInCallbackNotice
        userId={authSession?.user.id ?? null}
        verificationLinkError={
          !clientConfig || (managedAuthRequired && authSession === undefined)
            ? "pending"
            : managedAuthRequired &&
                !authSession &&
                !browserAccountsEnabled &&
                managedEmailVerificationRequired
              ? "auth-panel"
              : "notice"
        }
      />
      {clientConfig ? (
        <Suspense fallback={null}>
          <AnalyticsManager
            analyticsAccountId={
              routedWorkspace?.accountId ?? accessContext?.defaultAccountId ?? null
            }
            analyticsAccountResolved={
              accessContext !== null || (accessError !== null && !accessError.recovering)
            }
            analyticsUserId={authSession?.user.id ?? null}
            config={clientConfig.analytics}
            hasSearchParameters={hasSearchParameters}
            isPublicAuthRoute={isPublicAuthRoute}
            pathname={pathname}
            search={analyticsSearch}
          />
        </Suspense>
      ) : null}
      {clientConfig ? (
        <SecureContextWarning productAccessMode={clientConfig.productAccessMode} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{actorFencedSurface}</div>
    </main>
  );
}

export function pendingSlackLinkFromUrl(value: string): PendingSlackLink | null {
  const url = new URL(value, "https://opengeni.invalid");
  const match = /^\/workspaces\/([^/]+)\/capabilities\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const token = fragment.get("slack_link");
  if (!token || token.length > 2_048) return null;
  return { workspaceId: decodeURIComponent(match[1]), token };
}

export function invalidSlackLinkQueryWorkspaceIdFromUrl(value: string): string | null {
  const url = new URL(value, "https://opengeni.invalid");
  const match = /^\/workspaces\/([^/]+)\/capabilities\/?$/.exec(url.pathname);
  return match?.[1] && url.searchParams.has("slack_link") ? decodeURIComponent(match[1]) : null;
}

function pendingSlackLinkFromBrowserLocation(): PendingSlackLink | null {
  return typeof window === "undefined" ? null : pendingSlackLinkFromUrl(window.location.href);
}

function stripSlackLinkFromBrowserLocation(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const queryHasSlackLink = url.searchParams.has("slack_link");
  const rawFragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragment = new URLSearchParams(rawFragment);
  const fragmentHasSlackLink = fragment.has("slack_link");
  if (!queryHasSlackLink && !fragmentHasSlackLink) return;
  url.searchParams.delete("slack_link");
  if (fragmentHasSlackLink) {
    fragment.delete("slack_link");
    const nextFragment = fragment.toString();
    url.hash = nextFragment ? `#${nextFragment}` : "";
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function AccessKeyPanel(props: {
  authMode: ClientConfig["auth"]["mode"] | undefined;
  accessKeyDraft: string;
  setAccessKeyDraft: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-6"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <LockIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Access key required</h1>
            <p className="text-sm text-fg-subtle">
              Enter the{" "}
              {props.authMode === "configuredToken" ? "configured bearer token" : "deployment key"}{" "}
              for this Opengeni instance.
            </p>
          </div>
        </div>
        <Label htmlFor="access-key">Access key</Label>
        <Input
          id="access-key"
          type="password"
          value={props.accessKeyDraft}
          onChange={(event) => props.setAccessKeyDraft(event.target.value)}
          autoComplete="current-password"
          className="mt-2"
          autoFocus
        />
        <Button
          type="submit"
          className="mt-4 w-full"
          disabled={props.accessKeyDraft.trim().length === 0}
        >
          <CheckIcon className="size-4" />
          Continue
        </Button>
      </form>
    </section>
  );
}
