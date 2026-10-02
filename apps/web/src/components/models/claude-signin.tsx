import { reserveBrowserConnectNavigation } from "@opengeni/connect";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
  type IntegrationConnectTracker,
} from "@/lib/integration-connect-analytics";
import { OpenGeniApiError, type ClaudeSubscriptionOAuthStartResponse } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import type { ProviderConnectionView } from "../ai-gateway-connection";
import { Button } from "../ui/button";
import { Disclosure } from "../ui/disclosure";
import { Field, FieldStack } from "../ui/field";
import { SecretInput } from "../ui/secret-field";
import { ModelsFormPage, ProviderTile } from "./models-ui";
import { ClaudeTokenInstructions } from "./claude-setup";

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
}: {
  state: ProviderConnectionView;
  onClose(): void;
  onConnected(): void;
  footerStart?: React.ReactNode;
  /** Fields above the sign-in, such as which workspaces can use it. */
  fields?: React.ReactNode;
  /** Why it can't be connected yet (a choice above is incomplete). */
  blockedReason?: string | null | undefined;
  /** Runs once the subscription is saved, before its page opens (the form stays pending). */
  afterSave?: (() => Promise<void>) | undefined;
}) {
  const target = state.accessTarget;
  const scopeId = target.organizationId ?? target.workspaceId!;
  const storageKey = `opengeni.claude-signin:${state.organization ? "organization" : "workspace"}:${scopeId}`;
  const [attempt, setAttempt] = useState(() => recovered(storageKey));
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const popup = useRef<{ close(): void } | null>(null);
  // Consent-gated connect journey for the Claude subscription sign-in.
  const journey = useRef<IntegrationConnectTracker | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
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
    if (active.current) setCode("");
    popup.current?.close();
    popup.current = null;
  };
  return (
    <ModelsFormPage
      backLabel={state.connected ? "Claude subscription" : undefined}
      headerAside={<ProviderTile provider="claude_subscription" />}
      title={state.connected ? "Reconnect Claude subscription" : "Connect Claude subscription"}
      description="Use your Claude plan, with usage limits and reset times available here."
      onClose={() => {
        reset();
        onClose();
      }}
      submitLabel={
        legacy ? "Connect Claude subscription" : attempt ? "Complete sign-in" : "Sign in to Claude"
      }
      pendingLabel={attempt && !legacy ? "Connecting…" : "Starting sign-in…"}
      onPendingChange={setPending}
      submitDisabled={
        !state.canManageConnection ||
        Boolean(blockedReason) ||
        (legacy ? !token.trim() : Boolean(attempt && !code.trim()))
      }
      disabledReason={
        state.canManageConnection
          ? (blockedReason ?? undefined)
          : "Only people who can manage connections can connect Claude."
      }
      footerStart={
        footerStart ??
        (state.organization
          ? "Shared with your organization’s workspaces. You can limit access on the account page."
          : undefined)
      }
      onSubmit={async () => {
        if (legacy) {
          const saved = await state.saveKey(token);
          if (saved) {
            reset();
            await afterSave?.();
          }
          return saved;
        }
        if (!attempt) {
          const navigation = reserveBrowserConnectNavigation(window);
          try {
            const started = state.organization
              ? await target.client.startOrganizationClaudeSubscriptionOAuth(scopeId)
              : await target.client.startWorkspaceClaudeSubscriptionOAuth(scopeId);
            if (!active.current) {
              navigation.close();
              return false;
            }
            remember(started);
            journey.current?.finish("abandoned");
            journey.current = beginIntegrationConnect("claude_subscription", "oauth");
            popup.current = navigation.navigation.openPopup(started.authorizationUrl);
            return false;
          } catch (error) {
            navigation.close();
            throw error;
          }
        }
        if (Date.parse(attempt.expiresAt) <= Date.now()) {
          reset();
          throw new Error("Claude sign-in expired. Start again.");
        }
        const request = { attemptId: attempt.attemptId, code: code.trim() };
        try {
          await (state.organization
            ? target.client.completeOrganizationClaudeSubscriptionOAuth(scopeId, request)
            : target.client.completeWorkspaceClaudeSubscriptionOAuth(scopeId, request));
        } catch (error) {
          if (error instanceof OpenGeniApiError && [403, 409, 410, 502].includes(error.status))
            reset();
          journey.current?.finish(integrationConnectErrorOutcome(error));
          journey.current = null;
          throw error;
        }
        journey.current?.finish("connected");
        journey.current = null;
        reset();
        if (!active.current) return false;
        await state.refreshConnection();
        await afterSave?.();
        return true;
      }}
      onSubmitted={() => {
        if (active.current) onConnected();
      }}
    >
      <FieldStack>
        {fields}
        {!legacy ? (
          <>
            <p className="text-sm text-fg-muted">
              Sign in on Claude’s page and approve access. Copy the authorization code, close that
              window, and paste it here. No terminal command is needed.
            </p>
            {attempt ? (
              <>
                <Button asChild variant="outline" size="sm">
                  <a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">
                    Open Claude sign-in
                  </a>
                </Button>
                <Field
                  label="Authorization code"
                  hint="Copy the full code shown after you approve access in Claude."
                >
                  <SecretInput
                    ref={codeInput}
                    value={code}
                    autoComplete="off"
                    aria-label="Claude authorization code"
                    disabled={pending}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={reset}>
                  Start again
                </Button>
              </>
            ) : null}
          </>
        ) : null}
        <Disclosure
          title="Use a setup token"
          summary="Usage readings update after model calls"
          open={legacy}
          onOpenChange={(open) => {
            if (!pending) {
              setLegacy(open);
              setCode("");
              setToken("");
            }
          }}
          disabled={pending}
        >
          <FieldStack>
            <ClaudeTokenInstructions />
            <Field label="Setup token" hint="Stored encrypted. Connecting makes no model calls.">
              <SecretInput
                value={token}
                autoComplete="off"
                aria-label="Claude subscription setup token"
                disabled={pending}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
          </FieldStack>
        </Disclosure>
      </FieldStack>
    </ModelsFormPage>
  );
}
