import { afterEach, expect, test } from "bun:test";
import {
  beginSocialLoginAnalytics,
  clearLoginAnalytics,
  noteSuccessfulLogin,
  observeSocialLoginResult,
  takeSuccessfulLogin,
} from "./analytics-login";
import type { AuthSession } from "@/types";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  clearLoginAnalytics();
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});
function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: storage, localStorage: storage },
  });
  storage.setItem("opengeni.analyticsConsent", "granted");
  return storage;
}
function session(createdAt: number): AuthSession {
  return {
    user: { id: "u1", name: "Private", email: "private@example.test" },
    session: {
      id: "secret-session",
      userId: "u1",
      expiresAt: "",
      createdAt: new Date(createdAt).toISOString(),
    },
  };
}
test("successful email receipt is identity-bound and consumed once", () => {
  setup();
  noteSuccessfulLogin("u1", "email");
  expect(takeSuccessfulLogin("u1")).toMatchObject({ userId: "u1", method: "email" });
  expect(takeSuccessfulLogin("u1")).toBeNull();
});
test("OAuth return requires a newly created session, not an old cookie", () => {
  setup();
  beginSocialLoginAnalytics("google");
  observeSocialLoginResult(session(Date.now() - 60_000));
  expect(takeSuccessfulLogin("u1")).toBeNull();
  beginSocialLoginAnalytics("google");
  observeSocialLoginResult(session(Date.now()));
  expect(takeSuccessfulLogin("u1")).toMatchObject({ method: "google" });
});
test("denying consent drops pending login receipts", () => {
  const storage = setup();
  noteSuccessfulLogin("u1", "email");
  storage.setItem("opengeni.analyticsConsent", "denied");
  expect(takeSuccessfulLogin("u1")).toBeNull();
});
