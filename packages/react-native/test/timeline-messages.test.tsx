import { describe, expect, test } from "bun:test";
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
    expect(seen.value).toBe(defaultNativeTimelineMessages);
    expect(defaultNativeTimelineMessages.previewUnavailable("Chart")).toBe(
      "Chart (preview unavailable)",
    );
    await view.unmount();
  });

  test("nested providers merge, including the human-input outcomes", async () => {
    let seen = defaultNativeTimelineMessages;
    const view = await renderComponent(
      <NativeTimelineMessagesProvider
        messages={{
          showMore: "Vis mer",
          humanInputOutcome: {
            ...defaultNativeTimelineMessages.humanInputOutcome,
            answered: "Du svarte",
          },
        }}
      >
        <NativeTimelineMessagesProvider messages={{ showLess: "Vis mindre" }}>
          <Probe capture={(value) => (seen = value)} />
        </NativeTimelineMessagesProvider>
      </NativeTimelineMessagesProvider>,
    );
    expect(seen.showMore).toBe("Vis mer");
    expect(seen.showLess).toBe("Vis mindre");
    expect(seen.humanInputOutcome.answered).toBe("Du svarte");
    expect(seen.humanInputOutcome.skipped).toBe("Skipped");
    expect(seen.jumpToLatest).toBe("Jump to latest");
    await view.unmount();
  });
});
