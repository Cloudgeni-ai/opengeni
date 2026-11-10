// The renderer-neutral half of `ConnectSetup`: what the setup step says and
// does for a Connect attempt. The web form and the React Native card both
// draw from this, so they make the same decisions. No DOM.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectPopupClosedError,
  pollConnectAttempt,
  type ConnectAdvance,
  type ConnectAttempt,
  type ConnectController,
  type ConnectTransport,
} from "@opengeni/connect";
import { organizationAppApproval, type OrganizationAppApproval } from "@opengeni/contracts/connect";
import type { ConnectAttemptHints } from "./connect-window-host";
import {
  browserSignInMemory,
  forgetSignIn,
  rememberSignIn,
  signInNeverReturned,
  unreturnedSignIn,
} from "./connect-sign-in-memory";
import { useConnect, type ConnectView } from "./hooks/use-connect";
import { useOpenGeniText, type OpenGeniText } from "./messages/runtime";

export const connectSetupStatus = (t: OpenGeniText): Record<ConnectAttempt["state"], string> => ({
  ready: t("connectSetup.readyToConnect"),
  requires_user_action: t("connectSetup.authorizeYourAccount"),
  credential_input: t("connectSetup.enterConnectionDetails"),
  provider_wait: t("connectSetup.waitingForAuthorization2"),
  account_selection: t("connectSetup.chooseAnAccount"),
  resource_selection: t("connectSetup.chooseResources"),
  preview: t("connectSetup.chooseTools"),
  installing: t("connectSetup.addingSelectedTools"),
  connected_but_incomplete: t("connectSetup.chooseWhichToolsToAdd"),
  complete: t("connectSetup.connectionReady"),
  cancelled: t("connectSetup.setupCancelled"),
  expired: t("connectSetup.setupExpired"),
  failed: t("connectSetup.setupCouldNotFinish"),
  uncertain: t("connectSetup.setupOutcomeNeedsChecking"),
});

/** GitHub returned from a non-owner's install request: an organization owner must approve. */
export function isOwnerApprovalPending(attempt: Pick<ConnectAttempt, "error">): boolean {
  return attempt.error?.code === "owner_approval_pending";
}

/**
 * A built-in integration (Outlook, Gmail, ...) has one reviewed tool set, so
 * after the person signs in there is nothing left for them to choose: setup
 * continues to the preview and installs every reviewed tool by itself. Custom
 * OpenAPI or GraphQL sources keep the explicit tool review.
 */
export function isCuratedDefinitionAttempt(
  attempt: Pick<ConnectAttempt, "source" | "completionRequirement" | "mcpSetup">,
): boolean {
  return (
    attempt.completionRequirement === "integration" &&
    !attempt.mcpSetup &&
    (attempt.source === undefined || attempt.source.kind === "definition")
  );
}

/** The next step a built-in integration takes by itself, or null when the
 * person must act (or an error needs their attention). */
export function curatedAutoAdvance(attempt: ConnectAttempt): ConnectAdvance | null {
  if (!isCuratedDefinitionAttempt(attempt) || attempt.error) return null;
  const next = attempt.nextAction;
  if (attempt.state === "connected_but_incomplete" && next.type === "none")
    return { type: "retry" };
  if (attempt.state === "preview" && next.type === "preview")
    return {
      type: "install",
      previewId: next.previewId,
      contentHash: next.contentHash,
      operationIds: next.operations.map((operation) => operation.id),
    };
  return null;
}

/**
 * Whether setup the person already authorized can carry on without its
 * dialog: the sign-in was started (or came back) and what remains is waiting
 * for it or a built-in integration's automatic steps.
 */
export function connectSetupContinuesWithoutDialog(
  attempt: ConnectAttempt,
  signInStarted: boolean,
): boolean {
  if (
    attempt.error ||
    ["complete", "cancelled", "expired", "failed", "uncertain"].includes(attempt.state)
  )
    return false;
  if (curatedAutoAdvance(attempt)) return true;
  return signInStarted && ["authorize", "wait"].includes(attempt.nextAction.type);
}

/**
 * Carry a setup on after its dialog closed or the person moved on: wait for
 * the sign-in to come back and take a built-in integration's automatic steps.
 * Closing the dialog never stops setup the person already authorized. The
 * server normally finishes a built-in integration in its own callback, so this
 * usually only waits. Resolves with the completed attempt, or null when setup
 * needs the person again (or could not be read); it then stays resumable.
 */
export async function continueConnectSetup(
  transport: Pick<ConnectTransport, "get" | "advance">,
  attempt: ConnectAttempt,
  options: { signal?: AbortSignal; settleMs?: number } = {},
): Promise<ConnectAttempt | null> {
  const signal = options.signal ? { signal: options.signal } : {};
  let current = attempt;
  try {
    // Sign-in, then at most a preview and an install, plus a step the closed
    // dialog may still have had in flight.
    for (let step = 0; step < 6; step++) {
      if (current.state === "complete") return current;
      if (current.error) return null;
      const advance = curatedAutoAdvance(current);
      if (advance) {
        try {
          current = await transport.advance(
            current.workspaceId,
            current.id,
            {
              expectedRevision: current.revision,
              idempotencyKey: crypto.randomUUID(),
              action: advance,
            },
            signal,
          );
        } catch (error) {
          // A refusal (permission, policy, invalid step) needs the person.
          if (!connectStepMayHaveMoved(error)) return null;
          // A conflict or lost response: the dialog's own step can still be
          // running or already applied. Continue once the attempt moves.
          current = await settledConnectAttempt(transport, current, options);
        }
        continue;
      }
      if (!["authorize", "wait"].includes(current.nextAction.type)) return null;
      current = await pollConnectAttempt(transport, current.workspaceId, current.id, {
        ...signal,
        minimumRevision: current.revision,
        expiresAt: current.expiresAt,
      });
    }
    return current.state === "complete" ? current : null;
  } catch {
    return null;
  }
}

/** A conflict, server or network failure: the step may have run (or still be running). */
function connectStepMayHaveMoved(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  return typeof status !== "number" || status === 409 || status >= 500;
}

/** The attempt once it moved past `attempt`'s revision; throws if it does not in time. */
async function settledConnectAttempt(
  transport: Pick<ConnectTransport, "get">,
  attempt: ConnectAttempt,
  options: { signal?: AbortSignal; settleMs?: number },
): Promise<ConnectAttempt> {
  const deadline = Date.now() + (options.settleMs ?? 60_000);
  while (true) {
    options.signal?.throwIfAborted();
    const fresh = await transport.get(attempt.workspaceId, attempt.id, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (fresh.id !== attempt.id || fresh.workspaceId !== attempt.workspaceId)
      throw new Error("Connect response scope mismatch");
    if (fresh.revision > attempt.revision) return fresh;
    if (Date.now() >= deadline) throw new Error("Connect setup did not move");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const MICROSOFT_APPROVAL_LINK = /https:\/\/login\.microsoftonline\.com\/[^\s]+/;

/** Microsoft said, or may have said, that an administrator must approve the app first. */
export function adminApprovalLink(
  attempt: Pick<ConnectAttempt, "error">,
): { url: string; required: boolean } | null {
  const error = attempt.error;
  if (!error || !["admin_consent_required", "provider_denied"].includes(error.code)) return null;
  const match = MICROSOFT_APPROVAL_LINK.exec(error.message)?.[0];
  if (!match) return null;
  try {
    const url = new URL(match);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return { url: url.toString(), required: error.code === "admin_consent_required" };
  } catch {
    return null;
  }
}

/**
 * Help for an organization that must approve the app before its people can
 * connect. `required`: the provider said only an administrator can grant
 * access. `possible`: it declined, which is also how a person leaving its
 * "needs admin approval" page comes back. `unfinished`: the person was sent to
 * sign in and never came back, the other way that page ends.
 */
export type OrganizationApproval = {
  reason: "required" | "possible" | "unfinished";
  /** Link an administrator opens to approve the app, when the provider has one. */
  url: string | null;
  /** The app's client ID, for administrators who allow apps by ID. */
  appId: string | null;
};

/**
 * The approval help an attempt calls for. `unfinished` is the approval a
 * sign-in the person never came back from offers (see `connect-sign-in-memory`).
 */
export function organizationApprovalFor(
  attempt: Pick<ConnectAttempt, "error" | "nextAction">,
  unfinished: OrganizationAppApproval | null = null,
): OrganizationApproval | null {
  const link = adminApprovalLink(attempt);
  if (link) {
    const appId = new URL(link.url).searchParams.get("client_id");
    return { reason: link.required ? "required" : "possible", url: link.url, appId };
  }
  if (!unfinished || attempt.error || attempt.nextAction.type !== "authorize") return null;
  // The attempt's own sign-in names the app the person is about to approve.
  const current = organizationAppApproval(attempt.nextAction.url) ?? unfinished;
  return { reason: "unfinished", url: current.approvalUrl, appId: current.appId };
}

/**
 * The ready-made message a person sends their IT, in the host's words
 * (`connectSetup.itMessageWithLink` / `connectSetup.itMessageWithAppId`).
 */
export function organizationApprovalMessage(
  t: OpenGeniText,
  approval: Pick<OrganizationApproval, "url" | "appId">,
  serviceName: string | undefined,
): string | null {
  const service = serviceName?.trim() || t("connectSetup.myWorkAccount");
  if (approval.url) return t("connectSetup.itMessageWithLink", { service, link: approval.url });
  if (approval.appId)
    return t("connectSetup.itMessageWithAppId", { service, appId: approval.appId });
  return null;
}

/** The provider's device-verification page, when it is a safe HTTPS link. */
export function deviceVerificationUrl(action: ConnectAttempt["nextAction"]): string | null {
  if (action.type !== "wait" || !action.verificationUrl) return null;
  try {
    const url = new URL(action.verificationUrl);
    return url.protocol === "https:" && !url.username && !url.password
      ? action.verificationUrl
      : null;
  } catch {
    return null;
  }
}

/** Steps whose controls form one submitted form. */
const FORM_ACTIONS = new Set(["credentials", "select_account", "select_resources", "preview"]);

export type ConnectSetupFlowOptions = {
  /** Called synchronously from the person's tap, so a host can open its sign-in window. */
  onAuthorize: (attempt: ConnectAttempt) => void | Promise<unknown>;
  /** Called synchronously on Continue; hosts can reserve a window before advancing. */
  onSelectAccount?: ((accountId: string) => void | Promise<unknown>) | undefined;
  /**
   * A chat card hides "Check status" outside a finish-elsewhere step and offers
   * its own "Try again", so its error line points there instead.
   */
  inChat?: boolean | undefined;
  /**
   * Where sign-ins the person never came back from are remembered, so the next
   * visit can offer organization approval help. Defaults to the browser's
   * local storage; `null` turns it off (a chat card keeps its own).
   */
  signInMemory?: ConnectAttemptHints | null | undefined;
};

/** What a Connect setup step shows and the steps a person can take from it. */
export type ConnectSetupFlow = {
  view: ConnectView;
  attempt: ConnectAttempt | null;
  action: ConnectAttempt["nextAction"] | null;
  /** A step is running, or the person is being sent to sign in. */
  busy: boolean;
  navigating: boolean;
  awaitingOwner: boolean;
  autoFinishing: boolean;
  adminApproval: { url: string; required: boolean } | null;
  /** Organization approval help to show, or null. */
  organizationApproval: OrganizationApproval | null;
  terminal: boolean;
  /** The manual controls (form, sign-in, status and cancel) are shown. */
  interactive: boolean;
  /** The step's controls submit as one form. */
  formStep: boolean;
  verificationUrl: string | null;
  offersGitHubRequest: boolean;
  scopeLabel: string;
  scopeDescription: string;
  status: string;
  /** A plain line when the step could not continue, or null. */
  errorText: string | null;
  /**
   * The person closed the sign-in window before finishing. Not an error: the
   * attempt still waits, and the sign-in button offers to try again.
   */
  signInClosed: boolean;
  /** "Sign-in window closed…" while {@link signInClosed}, else null. */
  notice: string | null;
  submitLabel: string;
  invoke: (operation: () => unknown | Promise<unknown>) => void;
  /** Values go straight to the controller; nothing here keeps them. */
  submitCredentials: (values: Record<string, string>) => void;
  selectAccount: (accountId: string) => void;
  selectResources: (resourceIds: string[]) => void;
  install: (operationIds: string[]) => void;
  chooseTools: () => void;
  authorize: () => void;
  refresh: () => void;
  cancel: () => void;
};

/**
 * What a Connect setup step shows and the steps a person can take from it.
 * Values a person types are passed straight to the controller and never kept
 * here; a built-in integration's automatic steps run once per attempt revision.
 */
export function useConnectSetupFlow(
  controller: ConnectController,
  options: ConnectSetupFlowOptions,
): ConnectSetupFlow {
  const t = useOpenGeniText();
  const view = useConnect(controller);
  const [localError, setLocalError] = useState(false);
  const [signInClosed, setSignInClosed] = useState(false);
  const [navigating, setNavigating] = useState(false);
  // A sign-in to this connection the person never came back from, earlier.
  const [unreturned, setUnreturned] = useState<OrganizationAppApproval | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const memory =
    options.signInMemory !== undefined
      ? options.signInMemory
      : options.inChat
        ? null
        : browserSignInMemory;
  // One automatic step per attempt revision; a failure falls back to the
  // manual controls instead of retrying in a loop.
  const autoStep = useRef<string | null>(null);
  const invoke = useCallback((operation: () => unknown | Promise<unknown>) => {
    setLocalError(false);
    setSignInClosed(false);
    // Closing the sign-in window is the person's choice, not a failed step.
    const failed = (failure: unknown) =>
      failure instanceof ConnectPopupClosedError ? setSignInClosed(true) : setLocalError(true);
    try {
      void Promise.resolve(operation()).catch(failed);
    } catch (failure) {
      failed(failure);
    }
  }, []);
  const attempt = view.attempt;
  const awaitsSignIn = attempt?.nextAction.type === "authorize";
  useEffect(() => {
    setUnreturned(null);
    if (!attempt || !awaitsSignIn || !memory) return;
    const abort = new AbortController();
    void unreturnedSignIn(memory, controller.transport, attempt.workspaceId, attempt.providerId, {
      signal: abort.signal,
    })
      .then((approval) => {
        if (!abort.signal.aborted) setUnreturned(approval);
      })
      .catch(() => undefined);
    return () => abort.abort();
    // Checked once per attempt waiting for sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.id, awaitsSignIn, memory, controller]);
  // The provider answered, or setup moved on: nothing left to explain later.
  useEffect(() => {
    if (attempt && !signInNeverReturned(attempt)) forgetSignIn(memory, attempt);
  }, [attempt, memory]);
  useEffect(() => {
    if (!attempt || view.busy || localError || view.error) return;
    const step = `${attempt.id}:${attempt.revision}`;
    if (autoStep.current === step) return;
    const advance = curatedAutoAdvance(attempt);
    if (!advance) return;
    autoStep.current = step;
    invoke(() => view.advance(advance, crypto.randomUUID()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, view.busy, localError, view.error]);

  const action = attempt?.nextAction ?? null;
  const awaitingOwner = !!attempt && isOwnerApprovalPending(attempt);
  // While a built-in integration finishes by itself, show progress instead of
  // the manual tool chooser; any error brings the manual controls back.
  const autoFinishing =
    !!attempt &&
    !localError &&
    !view.error &&
    (curatedAutoAdvance(attempt) !== null ||
      (attempt.state === "installing" && isCuratedDefinitionAttempt(attempt) && !attempt.error));
  const adminApproval = attempt ? adminApprovalLink(attempt) : null;
  // Closing the sign-in window before finishing is the other way a provider's
  // "needs admin approval" page ends, so it offers the same help right away.
  const unfinished =
    attempt && signInClosed && attempt.nextAction.type === "authorize"
      ? (organizationAppApproval(attempt.nextAction.url) ?? unreturned)
      : unreturned;
  const organizationApproval = attempt ? organizationApprovalFor(attempt, unfinished) : null;
  const terminal = !!attempt && ["complete", "cancelled", "expired"].includes(attempt.state);
  const busy = view.busy || navigating;
  const run = (advance: ConnectAdvance) => {
    if (busy) return;
    const key = crypto.randomUUID();
    invoke(() => view.advance(advance, key));
  };
  return {
    view,
    attempt,
    action,
    busy,
    navigating,
    awaitingOwner,
    autoFinishing,
    adminApproval,
    organizationApproval,
    terminal,
    /** The manual controls (form, sign-in, status and cancel) are shown. */
    interactive: !!attempt && !terminal && !autoFinishing,
    /** The step's controls submit as one form. */
    formStep: !!action && FORM_ACTIONS.has(action.type),
    verificationUrl: action ? deviceVerificationUrl(action) : null,
    offersGitHubRequest:
      !!attempt &&
      action?.type === "select_account" &&
      attempt.providerId.startsWith("github") &&
      action.accounts.some((account) => account.id === "new"),
    scopeLabel: attempt
      ? attempt.ownership === "personal"
        ? t("connectSetup.personalConnection")
        : t("connectSetup.workspaceConnection")
      : "",
    scopeDescription: attempt
      ? attempt.ownership === "personal"
        ? t("connectSetup.onlyYourWorkCanUse")
        : t("connectSetup.workInThisWorkspaceCan")
      : "",
    status: !attempt
      ? t("connectSetup.chooseAConnectionToBegin")
      : awaitingOwner
        ? t("connectSetup.waitingForAnOrganizationOwner")
        : attempt.mcpSetup && attempt.state === "credential_input"
          ? t("connectSetup.enterTheRequestedKey")
          : autoFinishing
            ? t("connectSetup.finishingSetup")
            : connectSetupStatus(t)[attempt.state],
    errorText:
      attempt && (localError || view.error || (attempt.error && !awaitingOwner && !adminApproval))
        ? attempt.error?.code === "source_changed"
          ? t("connectSetup.theIntegrationSourceChangedReview")
          : attempt.error?.code === "mcp_verification_failed"
            ? t("connectSetup.couldNotVerifyThisConnection")
            : options.inChat
              ? t("connectSetup.setupCouldNotContinueTryAgain")
              : t("connectSetup.connectionSetupCouldNotContinue")
        : null,
    signInClosed,
    notice: signInClosed ? t("connectSetup.signInWindowClosed") : null,
    submitLabel:
      action?.type === "preview"
        ? t("connectSetup.addSelectedTools")
        : attempt?.mcpSetup && action?.type === "credentials"
          ? view.busy
            ? t("connectSetup.verifyingConnection")
            : t("connectSetup.connect")
          : t("connectSetup.continue"),
    invoke,
    submitCredentials(values: Record<string, string>) {
      if (action?.type !== "credentials") return;
      run({ type: "credentials", values });
    },
    selectAccount(accountId: string) {
      if (busy || action?.type !== "select_account") return;
      if (
        !action.accounts.some(
          (account) => account.id === accountId && account.status !== "disabled",
        )
      )
        return;
      const key = crypto.randomUUID();
      invoke(async () => {
        const select = latest.current.onSelectAccount;
        if (!select) return view.advance({ type: "account", accountId }, key);
        setNavigating(true);
        try {
          await select(accountId);
        } finally {
          setNavigating(false);
        }
      });
    },
    selectResources(resourceIds: string[]) {
      if (action?.type !== "select_resources" || action.cursor) return;
      run({ type: "resources", resourceIds });
    },
    install(operationIds: string[]) {
      if (action?.type !== "preview") return;
      run({
        type: "install",
        previewId: action.previewId,
        contentHash: action.contentHash,
        operationIds,
      });
    },
    chooseTools() {
      invoke(() => view.advance({ type: "retry" }, crypto.randomUUID()));
    },
    authorize() {
      if (!attempt) return;
      const snapshot = JSON.parse(JSON.stringify(attempt)) as ConnectAttempt;
      rememberSignIn(memory, snapshot);
      invoke(() => latest.current.onAuthorize(snapshot));
    },
    refresh() {
      invoke(() => view.refresh());
    },
    cancel() {
      invoke(() => view.cancel(crypto.randomUUID()));
    },
  };
}
