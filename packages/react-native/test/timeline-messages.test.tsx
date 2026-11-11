import { describe, expect, test } from "bun:test";
import { createOpenGeniText, OpenGeniMessagesProvider } from "@opengeni/react/messages";
import { registerDom, renderComponent } from "../../react/test/render-hook";
import {
  defaultNativeTimelineMessages,
  NativeTimelineMessagesProvider,
  useNativeTimelineMessages,
  type NativeTimelineMessages,
} from "../src/timeline/messages";

registerDom();

function Probe({ capture }: { capture: (value: NativeTimelineMessages) => void }) {
  capture(useNativeTimelineMessages());
  return null;
}

describe("native timeline messages", () => {
  test("defaults are English", async () => {
    const seen: { value?: NativeTimelineMessages } = {};
    const view = await renderComponent(<Probe capture={(value) => (seen.value = value)} />);
    expect(seen.value?.showMore).toBe(defaultNativeTimelineMessages(createOpenGeniText()).showMore);
    expect(seen.value?.showMore).toBe("Show more");
    expect(seen.value?.jumpToLatest).toBe("Jump to latest");
    expect(seen.value?.previewUnavailable("Chart")).toBe("Chart (preview unavailable)");
    await view.unmount();
  });

  test("the shared Opengeni catalog translates the native defaults", async () => {
    const seen: { value?: NativeTimelineMessages } = {};
    const view = await renderComponent(
      <OpenGeniMessagesProvider
        locale="nb"
        messages={{
          "native.timeline.messages.jumpToLatest": "Gå til siste",
          "native.timeline.messages.namePreviewUnavailable": "{name} (ingen forhåndsvisning)",
        }}
      >
        <Probe capture={(value) => (seen.value = value)} />
      </OpenGeniMessagesProvider>,
    );
    expect(seen.value?.jumpToLatest).toBe("Gå til siste");
    expect(seen.value?.previewUnavailable("Diagram")).toBe("Diagram (ingen forhåndsvisning)");
    // Keys the host leaves out stay English.
    expect(seen.value?.showMore).toBe("Show more");
    await view.unmount();
  });

  test("rows below one provider share one resolved object", async () => {
    const seen: NativeTimelineMessages[] = [];
    const view = await renderComponent(
      <NativeTimelineMessagesProvider messages={{ showMore: "Vis mer" }}>
        <Probe capture={(value) => seen.push(value)} />
        <Probe capture={(value) => seen.push(value)} />
      </NativeTimelineMessagesProvider>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]!);
    await view.unmount();
  });

  test("nested providers merge over the catalog, including the human-input outcomes", async () => {
    let seen: NativeTimelineMessages | undefined;
    const view = await renderComponent(
      <OpenGeniMessagesProvider
        messages={{ "native.timeline.messages.jumpToLatest": "Til bunnen" }}
      >
        <NativeTimelineMessagesProvider
          messages={{
            showMore: "Vis mer",
            humanInputOutcome: {
              ...defaultNativeTimelineMessages(createOpenGeniText()).humanInputOutcome,
              answered: "Du svarte",
            },
          }}
        >
          <NativeTimelineMessagesProvider messages={{ showLess: "Vis mindre" }}>
            <Probe capture={(value) => (seen = value)} />
          </NativeTimelineMessagesProvider>
        </NativeTimelineMessagesProvider>
      </OpenGeniMessagesProvider>,
    );
    expect(seen?.showMore).toBe("Vis mer");
    expect(seen?.showLess).toBe("Vis mindre");
    expect(seen?.humanInputOutcome.answered).toBe("Du svarte");
    expect(seen?.humanInputOutcome.skipped).toBe("Skipped");
    expect(seen?.jumpToLatest).toBe("Til bunnen");
    await view.unmount();
  });
});
