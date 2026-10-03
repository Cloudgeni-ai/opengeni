import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react/session-ui";

import { DEMO_WORKSPACE_ID, type RecordedClient } from "./recorded-client";
import { chatTokens, type ChatStyle } from "./style-knobs";

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
}: {
  client: RecordedClient;
  style: ChatStyle;
  sessionId: string | null;
  onSessionChange: (sessionId: string | null) => void;
  /** Bumps when the playground starts a chat itself, so the chat list re-reads. */
  epoch: number;
  person: string;
}) {
  const initials = person
    .split(/[\s@.]/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
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
      <section className="acme-agent" aria-label="Acme support chat (recorded demo)">
        <OpenGeniProvider client={client} workspaceId={DEMO_WORKSPACE_ID}>
          <OpenGeniChat key={epoch} sessionId={sessionId} onSessionChange={onSessionChange} />
        </OpenGeniProvider>
      </section>
    </div>
  );
}
