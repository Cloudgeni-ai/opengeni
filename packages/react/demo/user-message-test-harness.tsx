import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  Markdown,
  MessageTimeline,
  UserMessageBody,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react";
import "./styles.css";

type UserMessageHarness = {
  prepend: () => void;
  stream: () => void;
  scroller: () => HTMLElement;
};

declare global {
  interface Window {
    userMessageHarness?: UserMessageHarness;
  }
}

const LONG_MESSAGE = [
  "# Launch review notes",
  "",
  "This already-sent prompt is intentionally long and must remain completely available. ".repeat(
    10,
  ),
  "",
  "## Acceptance list",
  "",
  "- Preserve every Markdown paragraph and embedded newline.",
  "- Keep attachments and voice identity outside the collapsed text region.",
  "- Keep expansion stable while unrelated assistant output streams.",
  "",
  "> The reader's viewport—not a raw character count—owns presentation.",
  "",
  "```ts",
  "const multilingual = 'こんにちは · مرحبا · 👩🏽‍💻 · café';",
  "const lossless = true;",
  "```",
  "",
  `https://example.test/${"very-long-unbroken-url-segment-".repeat(28)}`,
  "",
  "Final paragraph after the URL so visual clipping cannot masquerade as data truncation.",
].join("\n");

function ordinaryUser(sequence: number): TimelineItem {
  return {
    kind: "user-message",
    id: `ordinary-${sequence}`,
    text: `Ordinary timeline message ${sequence}`,
    resources: [],
    tools: [],
    occurredAt: new Date(1_775_000_000_000 + sequence).toISOString(),
  };
}

function longUser(): UserMessageItem {
  return {
    kind: "user-message",
    id: "long-user-message",
    text: LONG_MESSAGE,
    resources: [
      { kind: "repository", uri: "https://github.com/example/long-message-demo.git", ref: "main" },
    ],
    tools: [],
    presentation: {
      kind: "realtime_voice_handoff",
      context: "Voice handoff context remains available outside the collapsed Markdown body.",
    },
    occurredAt: "2026-08-04T20:00:00.000Z",
  };
}

function assistant(text: string): TimelineItem {
  return {
    kind: "agent-message",
    id: "assistant-stream",
    turnId: "turn-long-message",
    text,
    streaming: true,
    occurredAt: "2026-08-04T20:00:01.000Z",
  };
}

function Harness() {
  const [streamed, setStreamed] = useState(false);
  const [prepended, setPrepended] = useState(false);
  const items = useMemo(
    () => [
      ...(prepended ? Array.from({ length: 8 }, (_, index) => ordinaryUser(index - 8)) : []),
      ...Array.from({ length: 14 }, (_, index) => ordinaryUser(index)),
      longUser(),
      assistant(
        streamed
          ? "Assistant output streamed after the user expanded the durable prompt. ".repeat(10)
          : "Assistant response is streaming.",
      ),
    ],
    [prepended, streamed],
  );

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    if (!node) {
      throw new Error("timeline scroller unavailable");
    }
    return node;
  }, []);

  useEffect(() => {
    window.userMessageHarness = {
      prepend: () => flushSync(() => setPrepended(true)),
      stream: () => flushSync(() => setStreamed(true)),
      scroller,
    };
    return () => {
      delete window.userMessageHarness;
    };
  }, [scroller]);

  const renderMessageText = useCallback((text: string, item: TimelineItem) => {
    if (item.kind !== "user-message") {
      return (
        <Markdown streaming={item.kind === "agent-message" && item.streaming}>{text}</Markdown>
      );
    }
    return (
      <div data-user-message-shell={item.id}>
        {item.presentation ? (
          <div data-voice-identity="" className="mb-2 text-og-sm font-medium text-og-fg-muted">
            Voice handoff
          </div>
        ) : null}
        {item.resources.length > 0 ? (
          <div
            data-message-attachments=""
            className="mb-2 rounded-og-md border border-og-border bg-og-surface-1 px-2 py-1 text-og-sm text-og-fg-muted"
          >
            Repository · long-message-demo · main
          </div>
        ) : null}
        <UserMessageBody messageId={item.id} text={text}>
          <Markdown>{text}</Markdown>
        </UserMessageBody>
        {item.presentation ? (
          <details data-voice-context="" className="mt-2 border-t border-og-border pt-2 text-og-sm">
            <summary>Context sent to agent</summary>
            <p>{item.presentation.context}</p>
          </details>
        ) : null}
      </div>
    );
  }, []);

  return (
    <main className="h-full bg-og-bg p-3 text-og-fg sm:p-8" data-og-theme="light">
      <section className="mx-auto flex h-full max-w-5xl flex-col">
        <header className="mb-3 shrink-0">
          <h1 className="text-xl font-semibold">Long sent user-message acceptance</h1>
          <p className="text-og-sm text-og-fg-muted">
            Lossless Markdown disclosure with fixed attachment and voice identity.
          </p>
        </header>
        <MessageTimeline
          className="min-h-0 flex-1 overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1"
          items={items}
          hasOlder
          renderMessageText={renderMessageText}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
