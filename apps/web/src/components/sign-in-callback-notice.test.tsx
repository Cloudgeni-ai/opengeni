import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3000" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { SignInCallbackNotice } = await import("./sign-in-callback-notice");

type Owner = "notice" | "pending" | "auth-panel";

async function renderAt(search: string, owners: Owner[]): Promise<string[]> {
  window.history.replaceState(null, "", `/${search}`);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const seen: string[] = [];
  try {
    for (const owner of owners) {
      await act(async () =>
        root.render(<SignInCallbackNotice userId={null} verificationLinkError={owner} />),
      );
      seen.push(container.textContent ?? "");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  }
  return seen;
}

describe("sign-in callback notice", () => {
  test("an expired verification link is left to the auth panel's resend form for good", async () => {
    const [pending, panel, signedIn] = await renderAt("?error=TOKEN_EXPIRED", [
      "pending",
      "auth-panel",
      "notice",
    ]);
    expect(pending).toBe("");
    expect(panel).toBe("");
    // Signing in after the panel took over never brings the stale notice back.
    expect(signedIn).toBe("");
  });

  test("the notice still reports a verification link the auth panel does not handle", async () => {
    const [pending, notice] = await renderAt("?error=INVALID_TOKEN", ["pending", "notice"]);
    expect(pending).toBe("");
    expect(notice).toContain("Sign-in needs attention");
    expect(notice).toContain("verification link has expired or is no longer valid");
  });

  test("other callback errors are unaffected by the auth panel", async () => {
    const [panel] = await renderAt("?error=access_denied", ["auth-panel"]);
    expect(panel).toContain("Sign-in was cancelled");
  });
});
