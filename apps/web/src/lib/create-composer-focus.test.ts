import { describe, expect, test } from "bun:test";

import { registerDom } from "../../../../packages/react/test/render-hook";
import {
  FOCUS_CREATE_COMPOSER_EVENT,
  requestCreateComposerFocus,
  type CreateComposerFocusIntent,
} from "./create-composer-focus";

registerDom();

describe("create composer focus intent", () => {
  test("preserves repeated explicit Default launches separately from omitted Recents intent", () => {
    const channelIds: Array<string | null | undefined> = [];
    const captureChannelId = (event: Event) => {
      channelIds.push((event as CustomEvent<CreateComposerFocusIntent>).detail.channelId);
    };
    window.addEventListener(FOCUS_CREATE_COMPOSER_EVENT, captureChannelId);

    requestCreateComposerFocus();
    requestCreateComposerFocus(null);
    requestCreateComposerFocus(null);
    window.removeEventListener(FOCUS_CREATE_COMPOSER_EVENT, captureChannelId);

    expect(channelIds).toEqual([undefined, null, null]);
  });
});
