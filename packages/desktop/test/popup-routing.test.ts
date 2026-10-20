import { describe, expect, test } from "bun:test";

import { routeNewWindow, routePopupNavigation } from "../src/main/popup-routing";

const base = "https://app.example.com";

describe("windows a web app opens", () => {
  test("a blank window reserved by an account's page is kept as a placeholder", () => {
    expect(routeNewWindow("about:blank", base)).toBe("placeholder");
    expect(routeNewWindow("", base)).toBe("placeholder");
  });

  test("a window with a known destination opens in the browser", () => {
    expect(routeNewWindow("https://docs.example.org/guide", base)).toBe("browser");
    expect(routeNewWindow(`${base}/workspaces`, base)).toBe("browser");
  });

  test("the local pages never keep placeholders", () => {
    expect(routeNewWindow("about:blank", null)).toBe("browser");
  });
});

describe("where a placeholder goes", () => {
  test("a provider's sign-in page opens in the browser", () => {
    expect(routePopupNavigation("https://accounts.google.com/o/oauth2/v2/auth?x=1", base)).toBe(
      "browser",
    );
    expect(routePopupNavigation("https://app.example.com.evil.test/", base)).toBe("browser");
  });

  test("the account's own page shows in the app", () => {
    expect(routePopupNavigation(`${base}/account-auth/abc`, base)).toBe("app");
  });

  test("staying blank decides nothing yet", () => {
    expect(routePopupNavigation("about:blank", base)).toBe("blank");
  });
});
