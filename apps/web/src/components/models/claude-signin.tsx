import { reserveBrowserConnectNavigation } from "@opengeni/connect";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
  type IntegrationConnectTracker,
} from "@opengeni/react/app/lib/integration-connect-analytics";
import { OpenGeniApiError, type ClaudeSubscriptionOAuthStartResponse } from "@opengeni/sdk";
import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import type { ProviderConnectionView } from "../ai-gateway-connection";
import { Button } from "@opengeni/react/ui/button";
import { apiErrorDetails, userErrorTextWithoutReference } from "@opengeni/react/ui/api-error";
import { ErrorMessage, type ErrorDetail } from "@opengeni/react/ui/error-message";
import { Field, FieldStack } from "@opengeni/react/ui/field";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SecretInput } from "@/components/ui/secret-field";
import { ModelsFormPage, ProviderTile } from "@opengeni/react/app/components/models/models-ui";
import { ClaudeTokenInstructions } from "./claude-setup";
import { SubscriptionConnectScope } from "./subscription-connect-scope";

function recovered(key: string): ClaudeSubscriptionOAuthStartResponse | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value.attemptId === "string" &&
      /^[a-f0-9-]{36}$/.test(value.attemptId) &&
      typeof value.expiresAt === "string" &&
      Date.parse(value.expiresAt) > Date.now() &&
      typeof value.authorizationUrl === "string"
    ) {
      const url = new URL(value.authorizationUrl);
      if (url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize")
        return value;
    }
  } catch {
    /* Storage can be disabled; sign-in still works. */
  }
  return null;
}

/** Shared model form and isolated browser navigation, as used by native connections. */
export function ClaudeSignInPage({
  state,
  onClose,
  onConnected,
  footerStart,
  fields,
  blockedReason,
  afterSave,
  accountPool = false,
  connectionScope = "workspace",
  reconnectAccountId,
  reconnectCredentialVersion,
  scopeChoice,
  onPendingChange,
}: {
  state: Pick<
    ProviderConnectionView,
    | "accessTarget"
    | "organization"
    | "connected"
    | "canManageConnection"
    | "saveKey"
    | "refreshConnection"
  >;
  onClose(): void;
  onConnected(accountId?: string): void;
  footerStart?: React.ReactNode;
  /** Fields above the sign-in, such as which workspaces can use it. */
  fields?: React.ReactNode;
  /** Why it can't be connected yet (a choice above is incomplete). */
  blockedReason?: string | null | undefined;
  /** Runs once the subscription is saved, before its page opens (the form stays pending). */
  afterSave?: ((accountId?: string) => Promise<void>) | undefined;
  accountPool?: boolean;
  connectionScope?: "workspace" | "user";
  reconnectAccountId?: string | undefined;
  reconnectCredentialVersion?: number | undefined;
  scopeChoice?: { scopeName: string; onChange(value: "workspace" | "user"): void } | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const target = state.accessTarget;
  const scopeId = target.organizationId ?? target.workspaceId!;
  const storageKey = `opengeni.claude-signin:${state.organization ? "organization" : "workspace"}:${scopeId}${accountPool ? ":" + connectionScope + ":" + (reconnectAccountId ?? "add") : ""}`;
  const [attempt, setAttempt] = useState(() => recovered(storageKey));
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [pending, setPending] = useState(false);
  // What to do next, with the request reference kept behind Technical details.
  const [error, setError] = useState<{
    title: string;
    reference?: string | undefined;
    details: ErrorDetail[];
  } | null>(null);
  const statusId = useId();
  const active = useRef(true);
  const popup = useRef<{ close(): void } | null>(null);
  // Consent-gated connect journey for the Claude subscription sign-in.
  const journey = useRef<IntegrationConnectTracker | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const savedAccountId = useRef<string | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      onPendingChange?.(false);
    };
  }, [onPendingChange]);
  useEffect(() => {
    if (attempt) codeInput.current?.focus();
  }, [attempt]);
  const remember = (value: ClaudeSubscriptionOAuthStartResponse | null) => {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else {
        // A late result from an unmounted form must not erase a newer sign-in.
        const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (!stored || stored.attemptId === attempt?.attemptId)
          sessionStorage.removeItem(storageKey);
      }
    } catch {
      /* Optional recovery only. */
    }
    if (active.current) setAttempt(value);
  };
  const reset = () => {
    remember(null);
    if (active.current) {
      setCode("");
      setError(null);
    }
    popup.current?.close();
    popup.current = null;
  };
  const submitLabel = legacy
    ? "Connect Claude"
    : attempt
      ? "Complete sign-in"
      : "Sign in to Claude";
  const pendingLabel = legacy || attempt ? "Connecting…" : "Starting sign-in…";
  const submitDisabled =
    !state.canManageConnection ||
    Boolean(blockedReason) ||
    (legacy ? !token.trim() : Boolean(attempt && !code.trim()));
  return (
    <ModelsFormPage
      backLabel={state.connected ? "Claude subscription" : undefined}
      headerAside={<ProviderTile provider="claude_subscription" />}
      title={state.connected ? "Reconnect Claude subscription" : "Connect Claude subscription"}
      description="Use your Claude plan to pay for models."
      onClose={() => {
        reset();
        onClose();
      }}
      submitLabel={submitLabel}
      onPendingChange={(value) => {
        if (!active.current) return;
        setPending(value);
        onPendingChange?.(value);
      }}
      submitDisabled={submitDisabled}
      footer={
        // Stack by the footer's own width, before three actions stop fitting on one row,
        // so "Start again" appearing never moves the primary action.
        <div className="@container/claude-actions w-full">
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {attempt && !legacy ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={reset}
                className="mr-auto pointer-coarse:h-11"
              >
                Start again
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                reset();
                onClose();
              }}
              className="pointer-coarse:h-11"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitDisabled}
              aria-disabled={pending || undefined}
              aria-describedby={statusId}
              className="w-52 pointer-coarse:h-11 @max-[30rem]/claude-actions:order-first @max-[30rem]/claude-actions:w-full"
            >
              {pending ? (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              ) : null}
              {pending ? pendingLabel : submitLabel}
            </Button>
          </div>
        </div>
      }
      onSubmit={async () => {
        setError(null);
        try {
          if (legacy) {
            const connected = accountPool
              ? await (state.organization
                  ? target.client.connectOrganizationClaudeSubscriptionSetupToken(scopeId, {
                      token,
                      ...(reconnectAccountId
                        ? {
                            reconnectAccountId,
                            expectedCredentialVersion: reconnectCredentialVersion,
                          }
                        : {}),
                    })
                  : target.client.connectClaudeSubscriptionSetupToken(scopeId, {
                      token,
                      scope: connectionScope,
                      ...(reconnectAccountId
                        ? {
                            reconnectAccountId,
                            expectedCredentialVersion: reconnectCredentialVersion,
                          }
                        : {}),
                    }))
              : null;
            if (connected) savedAccountId.current = connected.accountId;
            const saved = connected ? true : await state.saveKey(token);
            if (!active.current) return false;
            if (saved) {
              reset();
              if (accountPool) await state.refreshConnection();
              await afterSave?.(savedAccountId.current);
            }
            return saved;
          }
          if (!attempt) {
            const navigation = reserveBrowserConnectNavigation(window);
            try {
              const started = state.organization
                ? await target.client.startOrganizationClaudeSubscriptionOAuth(
                    scopeId,
                    reconnectAccountId ? { reconnectAccountId } : {},
                  )
                : await target.client.startWorkspaceClaudeSubscriptionOAuth(
                    scopeId,
                    accountPool
                      ? {
                          scope: connectionScope,
                          ...(reconnectAccountId ? { reconnectAccountId } : {}),
                        }
                      : {},
                  );
              if (!active.current) {
                navigation.close();
                return false;
              }
              remember(started);
              journey.current?.finish("abandoned");
              journey.current = beginIntegrationConnect("claude_subscription", "oauth");
              popup.current = navigation.navigation.openPopup(started.authorizationUrl);
              return false;
            } catch (startError) {
              navigation.close();
              throw startError;
            }
          }
          if (Date.parse(attempt.expiresAt) <= Date.now()) {
            reset();
            throw new Error("Claude sign-in expired. Start again.");
          }
          const request = { attemptId: attempt.attemptId, code: code.trim() };
          try {
            const connected = await (state.organization
              ? target.client.completeOrganizationClaudeSubscriptionOAuth(scopeId, request)
              : target.client.completeWorkspaceClaudeSubscriptionOAuth(scopeId, request));
            savedAccountId.current = connected.accountId;
          } catch (completeError) {
            if (
              completeError instanceof OpenGeniApiError &&
              [403, 409, 410, 502].includes(completeError.status)
            )
              reset();
            journey.current?.finish(integrationConnectErrorOutcome(completeError));
            journey.current = null;
            throw completeError;
          }
          journey.current?.finish("connected");
          journey.current = null;
          reset();
          if (!active.current) return false;
          await state.refreshConnection();
          await afterSave?.(savedAccountId.current);
          return true;
        } catch (caught) {
          if (active.current)
            setError({
              title: userErrorTextWithoutReference(caught, "Couldn't connect Claude. Try again."),
              ...apiErrorDetails(caught),
            });
          return false;
        }
      }}
      onSubmitted={() => {
        if (active.current) onConnected(savedAccountId.current);
      }}
    >
      <FieldStack>
        {fields}
        {scopeChoice ? (
          <SubscriptionConnectScope
            value={connectionScope}
            onChange={scopeChoice.onChange}
            scopeName={scopeChoice.scopeName}
            disabled={pending || Boolean(attempt)}
          />
        ) : null}
        <Field label="Sign-in method" group>
          <SegmentedControl
            className="self-start"
            value={legacy ? "token" : "browser"}
            options={[
              { value: "browser", label: "Browser" },
              { value: "token", label: "Setup token" },
            ]}
            disabled={pending}
            onValueChange={(method) => {
              setLegacy(method === "token");
              setCode("");
              setToken("");
              setError(null);
            }}
          />
        </Field>
        {/* Only an explicit method change resizes the form. Before and after
            sign-in starts, the browser step keeps the same copy and rows. */}
        <div className={legacy ? "min-h-60" : undefined}>
          <FieldStack className="gap-4">
            {!legacy ? (
              <>
                <p className="m-0 text-sm leading-5 text-fg-muted">
                  Approve access on Claude’s page, then paste the authorization code here.
                </p>
                <Field
                  label="Authorization code"
                  aside={
                    attempt ? (
                      <Button asChild variant="link" size="sm">
                        <a
                          href={attempt.authorizationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Claude sign-in
                        </a>
                      </Button>
                    ) : (
                      // The same link, hidden, so the label row keeps its size and baseline.
                      <Button asChild variant="link" size="sm" className="invisible">
                        <span aria-hidden="true">Open Claude sign-in</span>
                      </Button>
                    )
                  }
                  hint={
                    attempt
                      ? "Paste the full code, including any # suffix."
                      : "Start sign-in to get an authorization code."
                  }
                >
                  <SecretInput
                    ref={codeInput}
                    value={code}
                    autoComplete="off"
                    aria-label="Claude authorization code"
                    disabled={pending || !attempt}
                    onChange={(event) => {
                      setCode(event.target.value);
                      setError(null);
                    }}
                  />
                </Field>
              </>
            ) : (
              <>
                <ClaudeTokenInstructions />
                <Field
                  label="Setup token"
                  hint="Stored encrypted. Connecting makes no model calls."
                >
                  <SecretInput
                    value={token}
                    autoComplete="off"
                    aria-label="Claude subscription setup token"
                    disabled={pending}
                    onChange={(event) => {
                      setToken(event.target.value);
                      setError(null);
                    }}
                  />
                </Field>
              </>
            )}
          </FieldStack>
        </div>
        {/* Room for a two-line error and its Technical details, so it never moves the footer. */}
        <div id={statusId} className="min-h-18 text-sm leading-5">
          {error ? (
            <ErrorMessage
              variant="inline"
              announce
              title={error.title}
              reference={error.reference}
              details={error.details}
            />
          ) : blockedReason ? (
            <p className="m-0 text-fg-muted">{blockedReason}</p>
          ) : !state.canManageConnection ? (
            <p className="m-0 text-fg-muted">
              Only people who can manage connections can connect Claude.
            </p>
          ) : footerStart !== false ? (
            <div className="text-xs text-fg-muted">
              {footerStart ??
                (state.organization
                  ? "You can change workspace access on the account page."
                  : null)}
            </div>
          ) : null}
        </div>
      </FieldStack>
    </ModelsFormPage>
  );
}
