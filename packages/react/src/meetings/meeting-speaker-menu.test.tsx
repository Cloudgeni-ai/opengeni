import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RecordingPerson, RecordingSpeaker } from "@opengeni/contracts";

// The DOM comes first: menus portal only where a document existed at load.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SpeakerNameMenu } = await import("./meeting-transcript");
const { MeetingsOverlayScope } = await import("./overlay-scope");
type TranscriptActions = import("./meeting-transcript").TranscriptActions;

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: React.ReactNode) {
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { unmount: async () => await act(async () => root.unmount()) };
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

test("a speaker can be named as yourself", async () => {
  const named: string[] = [];
  const people = [
    {
      id: "p-me",
      displayName: "Ingrid Solberg",
      memberSubjectId: "me",
      email: null,
      externalRef: null,
      voice: null,
    },
    {
      id: "p-tomas",
      displayName: "Tomas Eriksen",
      memberSubjectId: null,
      email: null,
      externalRef: null,
      voice: null,
    },
  ] as unknown as RecordingPerson[];
  const actions = {
    nameSpeaker: async () => {},
    rejectSuggestion: async () => {},
    createPerson: async () => people[0]!,
    moveSegment: async () => {},
    editSegment: async () => {},
    voices: null,
    viewerSubjectId: "me",
    nameSelf: async (label: string) => {
      named.push(label);
    },
  } satisfies TranscriptActions;
  const menu = (speakers: RecordingSpeaker[]) => (
    <SpeakerNameMenu
      label="speaker_1"
      displayName="Speaker 2"
      speakers={speakers}
      people={people}
      actions={actions}
      onAddNew={() => {}}
      defaultOpen
    >
      <button type="button">Speaker 2</button>
    </SpeakerNameMenu>
  );
  const items = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
  const unnamed = await render(menu([]));
  try {
    await settle(50);
    // Yourself first, and not again further down the list.
    expect(items()[0]).toBe("It's me");
    expect(items()).not.toContain("Ingrid Solberg");
    expect(items()).toContain("Tomas Eriksen");
    const me = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!;
    await act(async () => me.click());
    await settle(50);
    expect(named).toEqual(["speaker_1"]);
  } finally {
    await unnamed.unmount();
  }
  const mine = await render(
    menu([
      {
        label: "speaker_1",
        personId: "p-me",
        name: "Ingrid Solberg",
        source: "confirmed",
        confidence: null,
      } as unknown as RecordingSpeaker,
    ]),
  );
  try {
    await settle(50);
    expect(items()).not.toContain("It's me");
  } finally {
    await mine.unmount();
  }
});

test("an embedded meeting's menus open inside Opengeni's styled root", async () => {
  const actions = {
    nameSpeaker: async () => {},
    nameSelf: null,
    rejectSuggestion: async () => {},
    createPerson: async () => ({}) as RecordingPerson,
    moveSegment: async () => {},
    editSegment: async () => {},
    voices: null,
    viewerSubjectId: "me",
  } satisfies TranscriptActions;
  // A host page that styles only its own og-root and provides no portal container.
  const page = await render(
    <div className="og-root">
      <MeetingsOverlayScope>
        <MeetingsOverlayScope>
          <SpeakerNameMenu
            label="speaker_1"
            displayName="Speaker 2"
            speakers={[]}
            people={[]}
            actions={actions}
            onAddNew={() => {}}
            defaultOpen
          >
            <button type="button">Speaker 2</button>
          </SpeakerNameMenu>
        </MeetingsOverlayScope>
      </MeetingsOverlayScope>
    </div>,
  );
  try {
    await settle(50);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    const layer = menu!.closest<HTMLElement>("[data-og-overlays]");
    // In a styled layer of its own under <body>, outside the host page's layout.
    expect(layer?.parentElement).toBe(document.body);
    expect(layer?.classList.contains("og-root")).toBe(true);
    // The nested scope shares the outer one's layer.
    expect(document.querySelectorAll("[data-og-overlays]").length).toBe(1);
  } finally {
    await page.unmount();
  }
});
