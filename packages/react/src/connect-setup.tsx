import { useState, type FormEvent } from "react";
import type { ConnectAttempt, ConnectController } from "@opengeni/connect";
import { copyTextToClipboard } from "./lib/clipboard";
import { useOpenGeniText } from "./messages/runtime";
import { useConnectSetupFlow } from "./connect-setup-model";

export {
  adminApprovalLink,
  curatedAutoAdvance,
  isCuratedDefinitionAttempt,
  isOwnerApprovalPending,
} from "./connect-setup-model";

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
  const flow = useConnectSetupFlow(controller, { onAuthorize, onSelectAccount });
  const { view, attempt, navigating, invoke } = flow;
  if (!attempt)
    return (
      <section
        className={["og-connect-setup", className].filter(Boolean).join(" ")}
        aria-label={t("connectSetup.connectionSetup")}
      >
        <p role="status">{flow.status}</p>
      </section>
    );
  const action = attempt.nextAction;
  const { verificationUrl, awaitingOwner, adminApproval, offersGitHubRequest } = flow;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (flow.busy) return;
    if (action.type === "credentials") {
      const values = Object.fromEntries(
        action.fields.map((field, i) => [field.name, String(data.get(`field-${i}`) ?? "")]),
      );
      // Clear the DOM before awaiting remote work; controller never retains values.
      form.reset();
      flow.submitCredentials(values);
    } else if (action.type === "select_account") {
      flow.selectAccount(String(data.get("account") ?? ""));
    } else if (action.type === "select_resources") {
      flow.selectResources(data.getAll("resource").map(String));
    } else if (action.type === "preview") {
      flow.install(data.getAll("operation").map(String));
    }
  };
  return (
    <section
      className={["og-connect-setup", className].filter(Boolean).join(" ")}
      aria-label={t("connectSetup.connectionSetup")}
      aria-busy={view.busy || navigating}
    >
      <div className="og-connect-setup-summary">
        <p className="og-connect-setup-scope">{flow.scopeLabel}</p>
        <p role="status" className="og-connect-setup-status">
          {flow.status}
        </p>
        <p className="og-connect-setup-description">{flow.scopeDescription}</p>
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
      {flow.errorText && <p role="alert">{flow.errorText}</p>}
      {flow.interactive && (
        <form key={`${attempt.id}:${attempt.revision}`} onSubmit={submit} autoComplete="off">
          <fieldset disabled={view.busy || navigating}>
            {flow.formStep ? (
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
                  onClick={flow.chooseTools}
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
            {flow.formStep && (
              <button
                type="submit"
                className="og-connect-setup-primary"
                disabled={action.type === "select_resources" && Boolean(action.cursor)}
              >
                {flow.submitLabel}
              </button>
            )}
            {action.type === "authorize" && (
              <button type="button" className="og-connect-setup-primary" onClick={flow.authorize}>
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
              <button type="button" onClick={flow.refresh}>
                {t("connectSetup.checkStatus")}
              </button>
              <button type="button" onClick={flow.cancel}>
                {t("connectSetup.cancelSetup")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
