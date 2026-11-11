import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingOnScreen } from "./meeting-on-screen";

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
const { MeetingDetailPage } = await import("./meeting-detail-page");
const { useMeetingOnScreen } = await import("./meeting-on-screen");
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

let onScreen: MeetingOnScreen | null = null;
function OnScreenProbe() {
  onScreen = useMeetingOnScreen(document);
  return null;
}

async function renderMeeting(onAsk?: (recordingId: string, question: string) => void) {
  document.body.replaceChildren();
  const fixture = createMeetingsFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MeetingRecorderStoreProvider value={createMeetingRecorderStore()}>
        <OnScreenProbe />
        <MeetingDetailPage
          workspaceId={fixture.workspaceId}
          recordingId={fixture.readyId}
          viewerSubjectId={fixture.viewerSubjectId}
          recordings={fixture.client}
          onBack={() => {}}
          onAsk={onAsk}
        />
      </MeetingRecorderStoreProvider>,
    ),
  );
  await waitFor(() => container.querySelector('form input[maxlength="4000"]') !== null || !onAsk);
  return {
    fixture,
    container,
    /** Leaves the meeting, keeping the probe. */
    leave: () => act(async () => root.render(<OnScreenProbe />)),
    unmount: () => act(async () => root.unmount()),
  };
}

test("the meeting on screen takes a question from the app's menu as its Ask field would", async () => {
  const asked: Array<[string, string]> = [];
  const view = await renderMeeting((recordingId, question) => {
    asked.push([recordingId, question]);
  });
  try {
    await waitFor(() => onScreen?.ask != null);
    expect(onScreen!.recordingId).toBe(view.fixture.readyId);
    // With no question, the cursor goes to the Ask field.
    await act(async () => onScreen!.ask!(null));
    expect(document.activeElement).toBe(
      view.container.querySelector('form input[maxlength="4000"]'),
    );
    await act(async () => onScreen!.ask!("Who owns the follow-ups?"));
    await waitFor(() => asked.length > 0);
    expect(asked).toEqual([[view.fixture.readyId, "Who owns the follow-ups?"]]);
    await view.leave();
    expect(onScreen).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("a meeting page whose host takes no questions offers none", async () => {
  const view = await renderMeeting();
  try {
    await waitFor(() => onScreen !== null);
    expect(onScreen!.ask).toBeNull();
  } finally {
    await view.unmount();
  }
});
