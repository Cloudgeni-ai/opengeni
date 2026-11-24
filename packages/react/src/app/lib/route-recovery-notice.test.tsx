import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { registerDom } from "../../../test/render-hook";
import {
  rememberRouteRecoveryNotice,
  resetRouteRecoveryNoticeForTests,
  routeRecoveryNoticeText,
  takeRouteRecoveryNotice,
} from "./route-recovery-notice";

registerDom();

beforeEach(() => {
  window.sessionStorage.clear();
  resetRouteRecoveryNoticeForTests();
});

afterEach(() => {
  resetRouteRecoveryNoticeForTests();
});

describe("the notice a redirect leaves for the page it opens", () => {
  test("is shown once by the next page", () => {
    rememberRouteRecoveryNotice("workspace_unavailable");
    expect(takeRouteRecoveryNotice()).toBe("workspace_unavailable");
    // Gone from storage: a later page load doesn't repeat it.
    expect(window.sessionStorage.length).toBe(0);
    resetRouteRecoveryNoticeForTests();
    expect(takeRouteRecoveryNotice()).toBeNull();
  });

  test("one this page keeps on its way out belongs to the next page", () => {
    expect(takeRouteRecoveryNotice()).toBeNull();
    rememberRouteRecoveryNotice("account_changed");
    expect(takeRouteRecoveryNotice()).toBeNull();
    resetRouteRecoveryNoticeForTests();
    expect(takeRouteRecoveryNotice()).toBe("account_changed");
  });

  test("ignores anything else stored under its key", () => {
    window.sessionStorage.setItem("opengeni.routeRecoveryNotice", "<script>");
    expect(takeRouteRecoveryNotice()).toBeNull();
  });

  test("says what happened in one short line", () => {
    expect(routeRecoveryNoticeText("account_changed")).toBe(
      "You're signed in with another account now, so we opened its workspace.",
    );
    expect(routeRecoveryNoticeText("workspace_unavailable")).toBe(
      "You don't have access to that workspace, so we opened one you can use.",
    );
  });
});
