import { integrationDefinitionIdFromCapabilityId } from "@opengeni/contracts";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { ConnectSetup } from "../connect-setup";
import { browserConnectWindowHost } from "../connect-window-host";
import { connectionServicePresentation } from "../connection-service-presentation";
import { useOpenGeniText } from "../messages/runtime";
import { useIntegrationCapabilityConnect } from "./integration-capability-connect-flow";
import { SessionCapabilityFrame } from "./session-capability-frame";

export { reconnectCandidate } from "./integration-capability-connect-flow";

/** The client methods the card uses. Session proxies that do not forward
 * Connect and integration routes cannot render it. */
export function supportsIntegrationCapabilityCard(client: unknown): client is OpenGeniClient {
  const candidate = client as Partial<Record<keyof OpenGeniClient, unknown>> | null;
  return (
    !!candidate &&
    typeof candidate.connectTransport === "function" &&
    typeof candidate.listApiIntegrations === "function" &&
    typeof candidate.getSession === "function" &&
    typeof candidate.updateSessionToolPolicy === "function"
  );
}

export type SessionIntegrationCapabilityCardProps = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  /** `api:integration:<definition id>` from the agent's recommendation. */
  capabilityId: string;
  name: string;
  rationale?: string;
  /** Exact host route the provider returns to after a full-page redirect. */
  returnUrl: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

/**
 * One-click Connect card for a reviewed integration recommended in chat. The
 * person viewing it signs in with their own account in a popup; setup then
 * installs the integration's reviewed tools for that personal account only,
 * never as a workspace account. It shows the viewer's own state, so a
 * teammate in a shared chat sees and connects their own account. When
 * Microsoft says an administrator must approve the app first, the shared
 * setup view shows the approval link to pass on, and "Try again" connects
 * after that.
 */
export function SessionIntegrationCapabilityCard(props: SessionIntegrationCapabilityCardProps) {
  return (
    <ScopedCard key={`${props.workspaceId}:${props.sessionId}:${props.capabilityId}`} {...props} />
  );
}

function ScopedCard({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  name,
  rationale = "",
  returnUrl,
  onConfigured,
}: SessionIntegrationCapabilityCardProps) {
  const t = useOpenGeniText();
  const definitionId = integrationDefinitionIdFromCapabilityId(capabilityId) ?? capabilityId;
  const presentation = connectionServicePresentation({ id: definitionId, label: name });
  const [windows] = useState(() => browserConnectWindowHost(window));
  const flow = useIntegrationCapabilityConnect({
    client,
    workspaceId,
    sessionId,
    capabilityId,
    name,
    returnUrl,
    windows,
    onConfigured,
  });
  const { availability, attempt, busy, waiting, error, chatAccessFailed, notRequester } = flow;
  // The button the person pressed disappears as the card changes step; move
  // focus to the step's own control so keyboard and screen reader users don't
  // land back at the top of the page. Only when focus was actually lost.
  const setupRef = useRef<HTMLDivElement>(null);
  const step = waiting ? "waiting" : busy ? "busy" : (attempt?.state ?? "none");
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (step === "busy") return;
    const region = setupRef.current;
    const active = region?.ownerDocument.activeElement;
    if (!region || (active && active !== region.ownerDocument.body)) return;
    const target =
      region.querySelector<HTMLElement>(".og-session-capability-waiting button") ??
      region.querySelector<HTMLElement>(
        ".og-session-capability-primary, .og-connect-setup-primary, button:not([disabled])",
      );
    (target ?? region).focus({ preventScroll: true });
  }, [step]);
  const retrySignIn = flow.signInClosed || Boolean(error);
  const setup =
    availability.kind === "ready" && (attempt || busy || error) ? (
      <div ref={setupRef} tabIndex={-1} className="og-session-capability-step">
        {error ? <p role="alert">{error}</p> : null}
        {flow.notice ? <p role="status">{flow.notice}</p> : null}
        {/* While the sign-in window is open, the card says so and offers one way
            out, which ends the attempt; the sign-in controls return if the
            window closes or the provider moves setup elsewhere. */}
        {waiting ? null : attempt ? (
          <ConnectSetup
            className="og-connect"
            controller={flow.controller}
            inChat
            authorizeLabel={
              retrySignIn
                ? t("connectSetup.trySigningInAgain")
                : t("sessionIntegrationCapabilityCard.signIn")
            }
            onAuthorize={flow.authorizeAttempt}
          />
        ) : busy ? (
          <p role="status">{t("sessionIntegrationCapabilityCard.preparing")}</p>
        ) : null}
        {waiting ? (
          <div className="og-session-capability-waiting">
            <span aria-hidden className="og-session-capability-spinner" />
            <p role="status">
              {t("sessionIntegrationCapabilityCard.finishSigningIn", { name: presentation.name })}
            </p>
            <span className="og-session-capability-waiting-actions">
              <button type="button" onClick={flow.reopenSignIn}>
                {t("sessionIntegrationCapabilityCard.reopenSignIn")}
              </button>
              <button
                type="button"
                className="og-session-capability-stop"
                onClick={flow.stopWaiting}
              >
                {t("sessionIntegrationCapabilityCard.stopWaiting")}
              </button>
            </span>
          </div>
        ) : null}
        {!busy && !waiting && (flow.restartable || (error && !attempt)) ? (
          <button type="button" className="og-session-capability-primary" onClick={flow.start}>
            {t("sessionIntegrationCapabilityCard.tryAgain")}
          </button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <SessionCapabilityFrame
      name={presentation.name}
      subtitle=""
      logo={presentation.logo}
      typeLabel={t("sessionIntegrationCapabilityCard.integration")}
      description={rationale}
      clampDescription
      skill={false}
      expanded={false}
      complete={availability.kind === "connected"}
      completeLabel={t("sessionIntegrationCapabilityCard.connected")}
      actionLabel={t("sessionIntegrationCapabilityCard.connectName", { name: presentation.name })}
      opensDialog={false}
      busy={busy || availability.kind === "loading"}
      note={t("sessionIntegrationCapabilityCard.note")}
      onOpen={flow.start}
      onClose={() => {}}
      inlineSetup={setup}
      actionUnavailable={
        availability.kind === "unavailable" ? (
          availability.reason
        ) : availability.kind === "error" ? (
          <>
            {t("sessionIntegrationCapabilityCard.couldNotLoad")}{" "}
            <button type="button" onClick={flow.reload}>
              {t("sessionIntegrationCapabilityCard.retry")}
            </button>
          </>
        ) : undefined
      }
      details={
        availability.kind === "connected" && (chatAccessFailed || notRequester) ? (
          <>
            {chatAccessFailed ? (
              <p role="status" className="og-session-capability-copy">
                {t("sessionIntegrationCapabilityCard.chatAccessFailed")}
              </p>
            ) : null}
            {notRequester ? (
              <p role="status" className="og-session-capability-copy">
                {t("sessionIntegrationCapabilityCard.notRequester")}
              </p>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
