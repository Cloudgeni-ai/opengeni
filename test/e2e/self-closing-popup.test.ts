import { expect, mock, test } from "bun:test";
import type { Page } from "playwright";
import { clickSelfClosingPopup } from "./self-closing-popup";

const closedTarget = () =>
  new Error("locator.click: Target page, context or browser has been closed\nCall log:");

function fixture(
  options: {
    clickError?: Error;
    closeError?: Error;
    popupClosed?: boolean;
    ownerClosed?: boolean;
    browserConnected?: boolean;
  } = {},
) {
  const order: string[] = [];
  const click = mock(async () => {
    order.push("click");
    if (options.clickError) throw options.clickError;
  });
  const popup = {
    waitForEvent: mock(async (event: string) => {
      expect(event).toBe("close");
      order.push("observe close");
      if (options.closeError) throw options.closeError;
    }),
    getByRole: mock((role: string, selector: unknown) => {
      expect(role).toBe("button");
      expect(selector).toEqual({ name: "Close window", exact: true });
      return { click };
    }),
    isClosed: () => options.popupClosed ?? true,
  } as unknown as Page;
  const owner = {
    isClosed: () => options.ownerClosed ?? false,
    context: () => ({
      browser: () => ({ isConnected: () => options.browserConnected ?? true }),
    }),
  } as unknown as Page;
  return { popup, owner, click, order };
}

test("self-closing popup observes closure before its single real button click", async () => {
  const { popup, owner, click, order } = fixture();
  await clickSelfClosingPopup(popup, owner);
  expect(order).toEqual(["observe close", "click"]);
  expect(click).toHaveBeenCalledTimes(1);
});

test("self-closing popup accepts the exact target-close race only after its closure", async () => {
  const { popup, owner, click } = fixture({ clickError: closedTarget() });
  await clickSelfClosingPopup(popup, owner);
  expect(click).toHaveBeenCalledTimes(1);
});

test("self-closing popup preserves unrelated click failures", async () => {
  const failure = new Error("locator.click: Timeout waiting for the button");
  const { popup, owner } = fixture({ clickError: failure });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toBe(failure);
});

test("self-closing popup does not accept the same words from an unrelated action", async () => {
  const failure = new Error("locator.fill: Target page, context or browser has been closed");
  const { popup, owner } = fixture({ clickError: failure });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toBe(failure);
});

test("self-closing popup rejects a target-close error without popup closure", async () => {
  const failure = closedTarget();
  const { popup, owner } = fixture({ clickError: failure, popupClosed: false });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toBe(failure);
});

test("self-closing popup still requires the actual close event", async () => {
  const failure = new Error("Timeout waiting for close");
  const { popup, owner } = fixture({ clickError: closedTarget(), closeError: failure });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toBe(failure);
});

for (const options of [{ ownerClosed: true }, { browserConnected: false }]) {
  test(`self-closing popup rejects lost owner/browser ${JSON.stringify(options)}`, async () => {
    const failure = closedTarget();
    const { popup, owner } = fixture({ clickError: failure, ...options });
    await expect(clickSelfClosingPopup(popup, owner)).rejects.toBe(failure);
  });
}

test("self-closing popup detects owner loss even if the click reports success", async () => {
  const { popup, owner } = fixture({ ownerClosed: true });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toThrow("owner/browser");
});

test("self-closing popup rejects a successful click without actual closure", async () => {
  const { popup, owner } = fixture({ popupClosed: false });
  await expect(clickSelfClosingPopup(popup, owner)).rejects.toThrow("owner/browser");
});
