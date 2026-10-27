import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM comes first: menus and toasts portal only where a document existed at load.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("sonner");
const { MeetingDetailPage } = await import("./meeting-detail-page");
const { createMeetingRecorderStore, MeetingRecorderStoreProvider } =
  await import("./recorder-context");
const { createMeetingsFixture } = await import("../testing/meetings-fixture");

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

async function waitFor(check: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await settle(50);
  }
}

const bodyText = () => document.body.textContent ?? "";

async function renderMeeting() {
  document.body.replaceChildren();
  const fixture = createMeetingsFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MeetingRecorderStoreProvider value={createMeetingRecorderStore()}>
        <Toaster />
        <MeetingDetailPage
          workspaceId={fixture.workspaceId}
          recordingId={fixture.readyId}
          viewerSubjectId={fixture.viewerSubjectId}
          voiceRecognition
          recordings={fixture.client}
          onBack={() => {}}
        />
      </MeetingRecorderStoreProvider>,
    ),
  );
  // The ready meeting has notes, so it opens on Summary; speakers are named in the transcript.
  await waitFor(() => transcriptTab(container) !== undefined);
  await act(async () => transcriptTab(container)!.click());
  await waitFor(
    () => container.querySelector('ol [aria-label="Speaker 2, name this speaker"]') !== null,
  );
  return {
    container,
    unmount: async () => {
      // Toasts live in one store for the whole file.
      toast.dismiss();
      await settle(500);
      await act(async () => root.unmount());
    },
  };
}

const transcriptTab = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-slot="segmented-control-item"]')].find(
    (item) => item.textContent?.trim() === "Transcript",
  );

/** Open the menu of an unnamed speaker's first turn and pick a person. */
async function nameSpeaker(container: HTMLElement, speaker: string, person: string) {
  const trigger = container.querySelector<HTMLElement>(
    `ol [aria-label="${speaker}, name this speaker"]`,
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
  });
  await settle(50);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === person,
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
  await settle(400);
}

const rememberButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Remember voice…",
  );

test("naming someone whose voice isn't remembered offers to remember it", async () => {
  const view = await renderMeeting();
  try {
    // Tomas has no remembered voice, so naming him says how he could be
    // suggested next time, and the action asks whether he agreed.
    await nameSpeaker(view.container, "Speaker 2", "Same person as Tomas Eriksen");
    await waitFor(() => bodyText().includes("Named Tomas Eriksen"));
    expect(bodyText()).toContain("If they agree, later meetings can suggest them.");
    expect(rememberButton()).toBeDefined();
    await act(async () => rememberButton()!.click());
    await waitFor(() => bodyText().includes("Remember Tomas Eriksen's voice?"));
  } finally {
    await view.unmount();
  }
});

test("naming someone whose voice is remembered offers nothing more", async () => {
  const view = await renderMeeting();
  try {
    await nameSpeaker(view.container, "Speaker 2", "Same person as Lea Haugen");
    await settle(400);
    expect(bodyText()).not.toContain("Remember voice…");
  } finally {
    await view.unmount();
  }
});
