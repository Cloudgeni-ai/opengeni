import { useRef, useState } from "react";
import { ChatComposer, type ComposerState } from "@opengeni/react";
import { QueueSurface } from "@opengeni/react/session-ui";
import type { ComposerDraft } from "@opengeni/sdk";
import { galleryQueue, galleryTurn, idleComposer } from "../src/dev/composer-chrome-fixtures";

/** Real components; the queue server is simulated locally for keyboard evidence. */
export function ComposerQueueFixture() {
  const [turns, setTurns] = useState(() => [
    { ...galleryTurn(1, "Add keyboard regression tests."), createdAt: "2026-10-09T11:00:00.000Z" },
    {
      ...galleryTurn(0, "Review the composer interaction."),
      createdAt: "2026-10-09T10:00:00.000Z",
    },
  ]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const focusRef = useRef<{ focusInput: () => void }>(null);
  const evidence = useRef({ edits: [] as string[], sends: 0 });
  Object.assign(window, { composerQueue: evidence.current });
  const composer: ComposerState = idleComposer({
    value: text,
    setValue: setText,
    draft,
    draftPersistence: "durable",
    hasDraftContent: () => text.length > 0 || draft !== null,
    applyDraft: (next) => {
      setText(next.text);
      setDraft(next);
    },
    canSend: text.length > 0,
    send: async () => {
      evidence.current.sends++;
      return true;
    },
  });
  const queue = galleryQueue({
    queue: turns,
    mutationError: error,
    editTurn: async (id) => {
      evidence.current.edits.push(id);
      if (new URLSearchParams(location.search).has("race")) {
        setError(new Error("That queued prompt changed before it could be edited."));
        return null;
      }
      const turn = turns.find((item) => item.id === id)!;
      setTurns((items) => items.filter((item) => item.id !== id));
      return {
        text: turn.prompt,
        resources: [],
        annotations: [],
        sourceTurnId: id,
        revision: 1,
      } as ComposerDraft;
    },
  });
  return (
    <main className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Edit a queued message</h1>
        <p className="mt-1 text-xs text-fg-muted">
          Production components · Sample queue with local-only checkout
        </p>
      </header>
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end p-6">
        <p className="mb-6 text-sm text-fg-muted">
          Press ↑ in the empty composer to edit the most recently queued message.
        </p>
        <QueueSurface
          queue={queue}
          composer={composer}
          onRequestComposerFocus={() => focusRef.current?.focusInput()}
        />
        <ChatComposer queue={queue} composer={composer} focusRef={focusRef} />
      </section>
    </main>
  );
}
