import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectAdvance, ConnectAttempt, ConnectController } from "@opengeni/connect";
import { copyTextToClipboard } from "./lib/clipboard";
import { useConnect } from "./hooks/use-connect";
import { useOpenGeniText, type OpenGeniText } from "./messages/runtime";

const setupStatus = (t: OpenGeniText): Record<ConnectAttempt["state"], string> => ({
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

function CopyLinkButton({ url }: { url: string }) {
  const t = useOpenGeniText();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="og-connect-setup-secondary"
      onClick={() =>
        void copyTextToClipboard(url).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? t("copyButton.copied") : t("connectSetup.copyAdminApprovalLink")}
    </button>
  );
}

function deviceVerificationUrl(action: ConnectAttempt["nextAction"]): string | null {
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

export type ConnectSetupProps = {
  controller: ConnectController;
  /** Called synchronously in the click handler so a host can open a popup. */
  onAuthorize: (attempt: ConnectAttempt) => void | Promise<unknown>;
  /** Called synchronously on Continue; hosts can reserve a popup before advancing. */
  onSelectAccount?: (accountId: string) => void | Promise<unknown>;
  /** Host pagination must retain selections across pages and submit the final set. */
  onBrowseResources?: (attempt: ConnectAttempt) => void | Promise<unknown>;
  className?: string;
  /** Provider-specific label supplied by the embedding host. */
  authorizeLabel?: string | undefined;
};

/** Controller-backed setup surface, styled by opt-in connect.css. No provider secrets enter React state. Host owns
 * chooser, controller lifetime, navigation and recovery after full redirect. */
export function ConnectSetup(props: ConnectSetupProps) {
  // Attempt IDs/revisions are not a substitute for actor scope. A host can
  // recover the same attempt through a replacement controller; never preserve
  // a previous actor's unsent credential DOM or local errors across that swap.
  const [scope, setScope] = useState(props.controller);
  const [generation, setGeneration] = useState(0);
  if (scope !== props.controller) {
    setScope(props.controller);
    setGeneration(generation + 1);
  }
  return <ScopedSetup key={generation} {...props} />;
}

function ScopedSetup({
  controller,
  onAuthorize,
  onBrowseResources,
  onSelectAccount,
  className,
  authorizeLabel: authorizeLabelProp,
}: ConnectSetupProps) {
  const t = useOpenGeniText();
  const authorizeLabel =
    authorizeLabelProp === undefined ? t("connectSetup.authorizeConnection") : authorizeLabelProp;
  const view = useConnect(controller);
  const [localError, setLocalError] = useState(false);
  const [navigating, setNavigating] = useState(false);
  // One automatic step per attempt revision; a failure falls back to the
  // manual controls below instead of retrying in a loop.
  const autoStep = useRef<string | null>(null);
  const invoke = (operation: () => unknown | Promise<unknown>) => {
    setLocalError(false);
    try {
      void Promise.resolve(operation()).catch(() => setLocalError(true));
    } catch {
      setLocalError(true);
    }
  };
  const attempt = view.attempt;
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
  if (!attempt)
    return (
      <section
        className={["og-connect-setup", className].filter(Boolean).join(" ")}
        aria-label={t("connectSetup.connectionSetup")}
      >
        <p role="status">{t("connectSetup.chooseAConnectionToBegin")}</p>
      </section>
    );
  const action = attempt.nextAction;
  const verificationUrl = deviceVerificationUrl(action);
  const terminal = ["complete", "cancelled", "expired"].includes(attempt.state);
  const awaitingOwner = isOwnerApprovalPending(attempt);
  // While a built-in integration finishes by itself, show progress instead of
  // the manual tool chooser; any error brings the manual controls back.
  const autoFinishing =
    !localError &&
    !view.error &&
    (curatedAutoAdvance(attempt) !== null ||
      (attempt.state === "installing" && isCuratedDefinitionAttempt(attempt) && !attempt.error));
  const adminApproval = adminApprovalLink(attempt);
  const offersGitHubRequest =
    action.type === "select_account" &&
    attempt.providerId.startsWith("github") &&
    action.accounts.some((account) => account.id === "new");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (view.busy || navigating) return;
    const key = crypto.randomUUID();
    if (action.type === "credentials") {
      const values = Object.fromEntries(
        action.fields.map((field, i) => [field.name, String(data.get(`field-${i}`) ?? "")]),
      );
      // Clear the DOM before awaiting remote work; controller never retains values.
      form.reset();
      invoke(() => view.advance({ type: "credentials", values }, key));
    } else if (action.type === "select_account") {
      const accountId = String(data.get("account") ?? "");
      if (
        action.accounts.some((account) => account.id === accountId && account.status !== "disabled")
      )
        invoke(async () => {
          if (!onSelectAccount) return view.advance({ type: "account", accountId }, key);
          setNavigating(true);
          try {
            await onSelectAccount(accountId);
          } finally {
            setNavigating(false);
          }
        });
    } else if (action.type === "select_resources") {
      if (action.cursor) return;
      const resourceIds = data.getAll("resource").map(String);
      invoke(() => view.advance({ type: "resources", resourceIds }, key));
    } else if (action.type === "preview") {
      const operationIds = data.getAll("operation").map(String);
      invoke(() =>
        view.advance(
          {
            type: "install",
            previewId: action.previewId,
            contentHash: action.contentHash,
            operationIds,
          },
          key,
        ),
      );
    }
  };
  return (
    <section
      className={["og-connect-setup", className].filter(Boolean).join(" ")}
      aria-label={t("connectSetup.connectionSetup")}
      aria-busy={view.busy || navigating}
    >
      <div className="og-connect-setup-summary">
        <p className="og-connect-setup-scope">
          {attempt.ownership === "personal"
            ? t("connectSetup.personalConnection")
            : t("connectSetup.workspaceConnection")}
        </p>
        <p role="status" className="og-connect-setup-status">
          {awaitingOwner
            ? t("connectSetup.waitingForAnOrganizationOwner")
            : attempt.mcpSetup && attempt.state === "credential_input"
              ? t("connectSetup.enterTheRequestedKey")
              : autoFinishing
                ? t("connectSetup.finishingSetup")
                : setupStatus(t)[attempt.state]}
        </p>
        <p className="og-connect-setup-description">
          {attempt.ownership === "personal"
            ? t("connectSetup.onlyYourWorkCanUse")
            : t("connectSetup.workInThisWorkspaceCan")}
        </p>
      </div>
      {attempt.account && <p>{t("connectSetup.accountLabel", { label: attempt.account.label })}</p>}
      {awaitingOwner && (
        <div className="og-connect-setup-pending">
          <p>{t("connectSetup.yourRequestWasSentGithub")}</p>
          <ol>
            <li>{t("connectSetup.anOrganizationOwnerApprovesThe")}</li>
            <li>{t("connectSetup.anOwnerThenConnectsThe")}</li>
          </ol>
          <p>{t("connectSetup.nothingIsConnectedUntilThen")}</p>
        </div>
      )}
      {adminApproval && (
        <div className="og-connect-setup-pending" role="alert">
          <p>
            {adminApproval.required
              ? t("connectSetup.microsoftAdminApprovalRequired")
              : t("connectSetup.microsoftAdminApprovalMaybe")}
          </p>
          <ol>
            <li>{t("connectSetup.sendTheApprovalLinkTo")}</li>
            <li>{t("connectSetup.afterTheyApproveConnectAgain")}</li>
          </ol>
          <p className="og-connect-setup-approval-link">
            <a href={adminApproval.url} target="_blank" rel="noreferrer noopener">
              {t("connectSetup.adminApprovalLink")}
            </a>
            <CopyLinkButton url={adminApproval.url} />
          </p>
        </div>
      )}
      {(localError || view.error || (attempt.error && !awaitingOwner && !adminApproval)) && (
        <p role="alert">
          {attempt.error?.code === "source_changed"
            ? t("connectSetup.theIntegrationSourceChangedReview")
            : attempt.error?.code === "mcp_verification_failed"
              ? t("connectSetup.couldNotVerifyThisConnection")
              : t("connectSetup.connectionSetupCouldNotContinue")}
        </p>
      )}
      {!terminal && !autoFinishing && (
        <form key={`${attempt.id}:${attempt.revision}`} onSubmit={submit} autoComplete="off">
          <fieldset disabled={view.busy || navigating}>
            {["credentials", "select_account", "select_resources", "preview"].includes(
              action.type,
            ) ? (
              <legend className={attempt.mcpSetup ? "og-capability-catalog-sr-only" : undefined}>
                {t("connectSetup.connectionDetails")}
              </legend>
            ) : null}
            {attempt.state === "connected_but_incomplete" &&
              action.type === "none" &&
              !awaitingOwner && (
                <button
                  type="button"
                  className="og-connect-setup-primary"
                  onClick={() => invoke(() => view.advance({ type: "retry" }, crypto.randomUUID()))}
                >
                  {t("connectSetup.chooseTools")}
                </button>
              )}
            {action.type === "credentials" &&
              action.fields.map((field, i) => (
                <label key={field.name}>
                  {field.label}
                  {field.options ? (
                    <select name={`field-${i}`} required={field.required} defaultValue="">
                      <option value="">
                        {field.required
                          ? t("connectSetup.chooseAnOption")
                          : t("connectSetup.noAccountPublicService")}
                      </option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name={`field-${i}`}
                      type={field.secret ? "password" : "text"}
                      required={field.required}
                      autoComplete="off"
                    />
                  )}
                </label>
              ))}
            {action.type === "select_account" && (
              <label>
                {t("connectSetup.account")}
                <select name="account" required defaultValue="">
                  <option value="" disabled>
                    {t("connectSetup.chooseAnAccount")}
                  </option>
                  {action.accounts.map((account) => (
                    <option
                      key={account.id}
                      value={account.id}
                      disabled={account.status === "disabled"}
                    >
                      {account.label} — {account.id} ({account.ownership})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {offersGitHubRequest && (
              <p className="og-connect-setup-hint">{t("connectSetup.donTSeeYourOrganization")}</p>
            )}
            {action.type === "select_resources" &&
              action.resources.map((resource) => (
                <label key={resource.id}>
                  <input type="checkbox" name="resource" value={resource.id} />
                  {resource.label} ({resource.kind})
                </label>
              ))}
            {action.type === "select_resources" && action.cursor && (
              <>
                <p>{t("connectSetup.moreResourcesAreAvailableReview")}</p>
                {onBrowseResources && (
                  <button
                    type="button"
                    onClick={() => invoke(() => onBrowseResources(structuredClone(attempt)))}
                  >
                    {t("connectSetup.browseAllResources")}
                  </button>
                )}
              </>
            )}
            {action.type === "preview" && (
              <>
                <p>{t("connectSetup.chooseTheToolsAgentsCan")}</p>
                {action.operations.map((operation) => (
                  <label key={operation.id}>
                    <input type="checkbox" name="operation" value={operation.id} />
                    {operation.label} ({operation.kind})
                  </label>
                ))}
              </>
            )}
            {["credentials", "select_account", "select_resources", "preview"].includes(
              action.type,
            ) && (
              <button
                type="submit"
                className="og-connect-setup-primary"
                disabled={action.type === "select_resources" && Boolean(action.cursor)}
              >
                {action.type === "preview"
                  ? t("connectSetup.addSelectedTools")
                  : attempt.mcpSetup && action.type === "credentials"
                    ? view.busy
                      ? t("connectSetup.verifyingConnection")
                      : t("connectSetup.connect")
                    : t("connectSetup.continue")}
              </button>
            )}
            {action.type === "authorize" && (
              <button
                type="button"
                className="og-connect-setup-primary"
                onClick={() => invoke(() => onAuthorize(structuredClone(attempt)))}
              >
                {navigating ? t("connectSetup.waitingForAuthorization") : authorizeLabel}
              </button>
            )}
            {action.type === "wait" && (
              <>
                {action.userCode && (
                  <p>
                    {t("connectSetup.verificationCode")} <code>{action.userCode}</code>
                  </p>
                )}
                <p>{t("connectSetup.completeProviderAuthorizationThenCheck")}</p>
                {verificationUrl && (
                  <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                    {t("connectSetup.openProviderVerificationPageNew")}
                  </a>
                )}
              </>
            )}
            <div className="og-connect-setup-secondary">
              <button type="button" onClick={() => invoke(() => view.refresh())}>
                {t("connectSetup.checkStatus")}
              </button>
              <button type="button" onClick={() => invoke(() => view.cancel(crypto.randomUUID()))}>
                {t("connectSetup.cancelSetup")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
