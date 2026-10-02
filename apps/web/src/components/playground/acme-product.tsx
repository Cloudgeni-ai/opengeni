import type { ReactNode } from "react";

import type { ExchangeId } from "./acme-script";
import { ScriptedChatView, type ScriptedChat } from "./scripted-chat";
import { chatTokens, type ChatStyle } from "./style-knobs";

/** The demo product: Acme's help page, with the recorded Opengeni chat embedded. */
export function AcmeProduct({
  chat,
  questions,
  finished,
  person,
  style,
  heroAside,
}: {
  chat: ScriptedChat;
  questions: readonly ExchangeId[];
  /** Outside the tour, everything has been asked. */
  finished: boolean;
  person: string;
  style: ChatStyle;
  heroAside?: ReactNode;
}) {
  const firstName = person.split(/[\s@.]/u)[0] || "there";
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
      data-tour="product"
    >
      <nav className="acme-nav" aria-label="Acme (sample product)">
        <span className="acme-logo">
          <b aria-hidden="true">A</b>acme
        </span>
        <span className="acme-links">
          <span>Shop</span>
          <span>Orders</span>
          <span>Billing</span>
          <span aria-current="page">Help</span>
        </span>
        <span className="acme-avatar" title={person} aria-hidden="true">
          {initials || "?"}
        </span>
      </nav>
      <main className="acme-main">
        <header className="acme-hero">
          <div>
            <p className="acme-kicker">Help center</p>
            <h1>Acme support</h1>
          </div>
          {heroAside}
        </header>
        <section className="acme-chat" aria-label="Acme support chat" data-tour="chat">
          <ScriptedChatView
            chat={chat}
            firstName={firstName}
            questions={questions}
            finished={finished}
          />
        </section>
      </main>
    </div>
  );
}
