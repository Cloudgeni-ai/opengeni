import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react/session-ui";
import type { MouseEvent } from "react";

import { DEMO_AUTHORIZATION_URL } from "./acme-script";
import { DEMO_WORKSPACE_ID, type RecordedClient } from "./recorded-client";
import { chatTokens, type ChatStyle } from "./style-knobs";

/** How long the demo's pretend sign-in takes before it reports success. */
export const CONNECT_MS = 900;

/**
 * Keeps the agent's reply in view after a click inside the chat paused the
 * timeline's auto-follow: presses the timeline's own "Jump to latest" while
 * the reply streams in.
 */
function followLatest(section: HTMLElement) {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const jump = Array.from(section.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Jump to latest",
    );
    jump?.click();
    if (ticks >= 16) clearInterval(timer);
  }, 400);
}

/**
 * Acme, the sample product: its own nav and page, with Opengeni's
 * `<OpenGeniChat />` embedded exactly as the snippet shows, running on the
 * recorded client.
 */
export function AcmeProduct({
  client,
  style,
  sessionId,
  onSessionChange,
  epoch,
  person,
  onConnected,
}: {
  client: RecordedClient;
  style: ChatStyle;
  sessionId: string | null;
  onSessionChange: (sessionId: string | null) => void;
  /** Bumps when the playground starts a chat itself, so the chat list re-reads. */
  epoch: number;
  person: string;
  /** The customer finished connecting a tool from the chat's Connect card. */
  onConnected: () => void;
}) {
  const initials = person
    .split(/[\s@.]/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  // The real Connect card links to the product's own sign-in. In the demo
  // that sign-in happens in place: the button shows it connecting, then
  // connected, and the customer carries on in the chat.
  const catchConnect = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.("a[href]");
    if (!(link instanceof HTMLElement)) return;
    if (link.getAttribute("href") !== DEMO_AUTHORIZATION_URL) return;
    event.preventDefault();
    if (link.dataset.demoConnect) return;
    link.dataset.demoConnect = "connecting";
    link.setAttribute("aria-label", "Connecting");
    const section = event.currentTarget as HTMLElement;
    setTimeout(() => {
      link.dataset.demoConnect = "connected";
      link.setAttribute("aria-label", "Connected");
      onConnected();
      followLatest(section);
    }, CONNECT_MS);
  };
  return (
    <div
      className="og-root og-playground-product"
      data-og-theme={style.theme}
      style={chatTokens(style)}
      data-playground-product=""
    >
      <nav className="acme-nav" aria-label="Acme (sample product)">
        <span className="acme-logo">
          <b aria-hidden="true">A</b>acme
        </span>
        <span className="acme-links" aria-hidden="true">
          <span>Shop</span>
          <span>Orders</span>
          <span aria-current="page">Support</span>
        </span>
        <span className="acme-avatar" title={person} aria-hidden="true">
          {initials || "?"}
        </span>
      </nav>
      <section
        className="acme-agent"
        aria-label="Acme support chat (recorded demo)"
        onClickCapture={catchConnect}
      >
        <OpenGeniProvider client={client} workspaceId={DEMO_WORKSPACE_ID}>
          <OpenGeniChat key={epoch} sessionId={sessionId} onSessionChange={onSessionChange} />
        </OpenGeniProvider>
      </section>
    </div>
  );
}
