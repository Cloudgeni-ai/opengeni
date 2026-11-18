import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { consoleSignInRedirect } from "@/routes/console-sign-in";
import { ConsoleSignedOutPanel } from "./console-signed-out-panel";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(props: {
  search: string;
  signedOut?: boolean;
  lastAutoStartedAt?: number | null;
}): Promise<{ container: HTMLElement; root: Root; starts: () => number }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let count = 0;
  await act(async () => {
    root.render(
      <StrictMode>
        <ConsoleSignedOutPanel
          search={props.search}
          signedOut={props.signedOut ?? false}
          lastAutoStartedAt={props.lastAutoStartedAt ?? null}
          onContinue={() => {
            count += 1;
          }}
          fallback={<form aria-label="Console sign-in">Email and Google</form>}
        />
      </StrictMode>,
    );
  });
  return { container, root, starts: () => count };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe("Console's signed-out panel", () => {
  test("continues with the app's account once, on its own", async () => {
    const { container, root, starts } = await render({ search: "" });
    expect(starts()).toBe(1);
    expect(container.textContent).toContain("Signing in with your Opengeni account");
    expect(button(container, "Continuing…").disabled).toBe(true);
    await act(async () => root.unmount());
  });

  test("after Sign out it waits for Continue", async () => {
    const { container, root, starts } = await render({ search: "", signedOut: true });
    expect(starts()).toBe(0);
    expect(container.textContent).toContain("Sign in to Console");
    await act(async () => button(container, "Continue").click());
    expect(starts()).toBe(1);
    await act(async () => root.unmount());
  });

  test("a handoff that didn't finish says so and waits", async () => {
    const { container, root, starts } = await render({ search: "?console_sign_in=failed" });
    expect(starts()).toBe(0);
    expect(container.textContent).toContain("That sign-in didn't finish");
    await act(async () => root.unmount());
  });

  test("Console's own email and Google sign-in stay one click away", async () => {
    const { container, root, starts } = await render({ search: "", signedOut: true });
    await act(async () => button(container, "Sign in with email or Google").click());
    expect(container.querySelector("form")?.textContent).toBe("Email and Google");
    await act(async () => button(container, "Continue with your Opengeni account").click());
    expect(starts()).toBe(1);
    await act(async () => root.unmount());
  });

  test("without a handoff, only Console's own sign-in shows", async () => {
    const { container, root, starts } = await render({ search: "?console_sign_in=unavailable" });
    expect(starts()).toBe(0);
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).not.toContain("Continue with your Opengeni account");
    await act(async () => root.unmount());
  });
});

describe("the app host's Console sign-in page", () => {
  test("goes only to the Console origin it was asked for", () => {
    const console_ = "https://console.opengeni.ai";
    const code = `${console_}/v1/console-sign-in/callback?code=${"a".repeat(43)}`;
    expect(consoleSignInRedirect(code, console_)).toBe(code);
    expect(consoleSignInRedirect("https://evil.test/x", console_)).toBeNull();
    expect(consoleSignInRedirect("javascript:alert(1)", console_)).toBeNull();
    expect(consoleSignInRedirect("not a url", console_)).toBeNull();
  });
});
