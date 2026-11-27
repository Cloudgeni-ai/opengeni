import { describe, expect, test } from "bun:test";
import { readIosAppContext } from "./ios-app-context";

function tab() {
  const storage = new Map<string, string>();
  return (path: string) =>
    readIosAppContext({
      location: new URL(path, "https://app.example.test"),
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
    });
}

describe("hosted iOS app context", () => {
  test("recognizes the explicit marker at any SPA entry and remembers it only in that tab", () => {
    const first = tab();
    expect(first("/workspaces/a/organization?section=billing")).toBe(false);
    expect(first("/workspaces/a/organization?section=billing&client=ios#balance")).toBe(true);
    expect(first("/workspaces/a/settings")).toBe(true);
    expect(tab()("/workspaces/a/settings")).toBe(false);
  });

  test("recognizes native iOS sign-in, not a platform hint on another route or device", () => {
    const signIn = tab();
    expect(signIn("/workspaces/a/settings?platform=ios")).toBe(false);
    expect(signIn("/native-sign-in?platform=android")).toBe(false);
    expect(signIn("/native-sign-in?platform=office&client=IOS")).toBe(false);
    expect(
      signIn("/native-sign-in/?redirect_uri=opengeni%3A%2F%2Fauth%2Fcallback&platform=ios"),
    ).toBe(true);
    expect(signIn("/account-auth")).toBe(true);
  });

  test("honors explicit entry when accessing session storage throws", () => {
    const withoutStorage = (path: string) =>
      readIosAppContext({
        location: new URL(path, "https://app.example.test"),
        get sessionStorage(): Storage {
          throw new DOMException("Blocked", "SecurityError");
        },
      });
    expect(withoutStorage("/workspaces/a/organization?client=ios")).toBe(true);
    expect(withoutStorage("/native-sign-in?platform=ios")).toBe(true);
    expect(withoutStorage("/workspaces/a/organization")).toBe(false);
  });
});
