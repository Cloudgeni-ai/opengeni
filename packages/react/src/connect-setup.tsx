import { useState, type FormEvent } from "react";
import type { ConnectAttempt, ConnectController } from "@opengeni/connect";
import { useConnect } from "./connect";

const setupStatus: Record<ConnectAttempt["state"], string> = {
  ready: "Ready to connect",
  requires_user_action: "Authorize your account",
  credential_input: "Enter connection details",
  provider_wait: "Waiting for authorization",
  account_selection: "Choose an account",
  resource_selection: "Choose resources",
  preview: "Review available operations",
  installing: "Installing selected operations…",
  connected_but_incomplete: "Account connected — finish setup",
  complete: "Connection ready",
  cancelled: "Setup cancelled",
  expired: "Setup expired",
  failed: "Setup could not finish",
  uncertain: "Setup outcome needs checking",
};

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
  /** Host pagination must retain selections across pages and submit the final set. */
  onBrowseResources?: (attempt: ConnectAttempt) => void | Promise<unknown>;
  className?: string;
};

/** Unstyled setup surface. No provider secrets enter React state. Host owns
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

function ScopedSetup({ controller, onAuthorize, onBrowseResources, className }: ConnectSetupProps) {
  const view = useConnect(controller);
  const [localError, setLocalError] = useState(false);
  const invoke = (operation: () => unknown | Promise<unknown>) => {
    setLocalError(false);
    try {
      void Promise.resolve(operation()).catch(() => setLocalError(true));
    } catch {
      setLocalError(true);
    }
  };
  const attempt = view.attempt;
  if (!attempt)
    return (
      <section className={className} aria-label="Connection setup">
        <p role="status">Choose a connection to begin.</p>
      </section>
    );
  const action = attempt.nextAction;
  const verificationUrl = deviceVerificationUrl(action);
  const terminal = ["complete", "cancelled", "expired"].includes(attempt.state);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (view.busy) return;
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
        invoke(() => view.advance({ type: "account", accountId }, key));
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
    <section className={className} aria-label="Connection setup" aria-busy={view.busy}>
      <p>Ownership: {attempt.ownership === "personal" ? "Personal" : "Workspace"}</p>
      <p role="status">{setupStatus[attempt.state]}</p>
      {attempt.account && <p>Account: {attempt.account.label}</p>}
      {(localError || view.error || attempt.error) && (
        <p role="alert">
          {attempt.error?.code === "source_changed"
            ? "The integration source changed. Review the new operations before installing."
            : "Connection setup could not continue. Refresh its status before trying again."}
        </p>
      )}
      {!terminal && (
        <form key={`${attempt.id}:${attempt.revision}`} onSubmit={submit} autoComplete="off">
          <fieldset disabled={view.busy}>
            <legend>Connection details</legend>
            {attempt.state === "connected_but_incomplete" && action.type === "none" && (
              <button
                type="button"
                onClick={() => invoke(() => view.advance({ type: "retry" }, crypto.randomUUID()))}
              >
                Review integration operations
              </button>
            )}
            {action.type === "credentials" &&
              action.fields.map((field, i) => (
                <label key={field.name}>
                  {field.label}
                  {field.options ? (
                    <select name={`field-${i}`} required={field.required} defaultValue="">
                      <option value="">
                        {field.required ? "Choose an option" : "No account (public service)"}
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
                Account
                <select name="account" required defaultValue="">
                  <option value="" disabled>
                    Choose an account
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
            {action.type === "select_resources" &&
              action.resources.map((resource) => (
                <label key={resource.id}>
                  <input type="checkbox" name="resource" value={resource.id} />
                  {resource.label} ({resource.kind})
                </label>
              ))}
            {action.type === "select_resources" && action.cursor && (
              <>
                <p>More resources are available. Review all pages before submitting a selection.</p>
                {onBrowseResources && (
                  <button
                    type="button"
                    onClick={() => invoke(() => onBrowseResources(structuredClone(attempt)))}
                  >
                    Browse all resources
                  </button>
                )}
              </>
            )}
            {action.type === "preview" && (
              <>
                <p>Select the operations to install.</p>
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
                disabled={action.type === "select_resources" && Boolean(action.cursor)}
              >
                {action.type === "preview" ? "Install selected operations" : "Continue"}
              </button>
            )}
            {action.type === "authorize" && (
              <button
                type="button"
                onClick={() => invoke(() => onAuthorize(structuredClone(attempt)))}
              >
                Authorize connection
              </button>
            )}
            {action.type === "wait" && (
              <>
                {action.userCode && (
                  <p>
                    Verification code: <code>{action.userCode}</code>
                  </p>
                )}
                <p>Complete provider authorization, then check the connection status.</p>
                {verificationUrl && (
                  <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                    Open provider verification page (new tab)
                  </a>
                )}
              </>
            )}
            <button type="button" onClick={() => invoke(() => view.refresh())}>
              Check status
            </button>
            <button type="button" onClick={() => invoke(() => view.cancel(crypto.randomUUID()))}>
              Cancel setup
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
