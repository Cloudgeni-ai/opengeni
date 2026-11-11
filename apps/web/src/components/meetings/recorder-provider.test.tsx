// Who the recorder belongs to: a moment of not knowing (a reconnect, an
// update, a sign-in being read again) must not end a recording, but a real
// sign-out or another person must.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { LostTrackTabTitle, useRecorderPerson } = await import("./recorder-provider");
const { createMeetingRecorderStore, MeetingRecorderStoreProvider } =
  await import("@opengeni/react/meetings-recorder");

describe("The tab's title while a source is gone", () => {
  test("says the microphone is off, survives a page renaming the tab, and goes when it's back", async () => {
    const store = createMeetingRecorderStore();
    const recorder = (lost?: "reconnecting" | "stopped") =>
      ({
        state: "recording",
        systemAudioKind: "display",
        tracks: [
          { trackNumber: 0, source: "microphone", label: "Mic", ...(lost ? { lost } : {}) },
          { trackNumber: 1, source: "system", label: "Tab" },
        ],
      }) as unknown as Parameters<typeof store.set>[0];
    document.title = "Meetings";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () => new Promise((done) => setTimeout(done, 0));
    try {
      await act(async () =>
        root.render(
          <MeetingRecorderStoreProvider value={store}>
            <LostTrackTabTitle />
          </MeetingRecorderStoreProvider>,
        ),
      );
      await act(async () => store.set(recorder()));
      expect(document.title).toBe("Meetings");
      await act(async () => store.set(recorder("reconnecting")));
      expect(document.title).toBe("Microphone off · Meetings");
      // Another page sets its own title.
      await act(async () => {
        document.title = "Weekly sync";
        await settle();
      });
      expect(document.title).toBe("Microphone off · Weekly sync");
      await act(async () => store.set(recorder()));
      expect(document.title).toBe("Weekly sync");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("The recorder's person", () => {
  test("keeps the last person known while it is read again, and follows real changes", async () => {
    const seen: (string | null)[] = [];
    function Probe({ person }: { person: string | null | undefined }) {
      seen.push(useRecorderPerson(person));
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (person: string | null | undefined) =>
      act(async () => root.render(<Probe person={person} />));
    const now = () => seen.at(-1);
    try {
      await render(undefined);
      expect(now()).toBeNull();
      await render("person-1");
      expect(now()).toBe("person-1");
      await render(undefined);
      expect(now()).toBe("person-1");
      await render("person-2");
      expect(now()).toBe("person-2");
      await render(null);
      expect(now()).toBeNull();
      await render(undefined);
      expect(now()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
