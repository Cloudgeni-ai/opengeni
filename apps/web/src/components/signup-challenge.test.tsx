import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SignupChallenge } = await import("./signup-challenge");
afterAll(() => GlobalRegistrator.unregister());
test("challenge lifecycle clears expired/error tokens, resets on retries and removes the widget", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tokens: (string | undefined)[] = [];
  const removed: string[] = [];
  let options: Record<string, unknown> = {};
  let rendered = 0;
  window.turnstile = {
    render: (_element, value) => {
      options = value;
      return String(++rendered);
    },
    remove: (id) => {
      removed.push(id);
    },
  };
  try {
    await act(async () =>
      root.render(<SignupChallenge siteKey="test-key" onToken={(token) => tokens.push(token)} />),
    );
    expect(options.action).toBe("signup");
    await act(async () => (options.callback as (token: string) => void)("pass"));
    expect(tokens.at(-1)).toBe("pass");
    await act(async () => (options["expired-callback"] as () => void)());
    expect(tokens.at(-1)).toBeUndefined();
    await act(async () => (options["error-callback"] as () => void)());
    expect(host.textContent).toContain("Verification couldn't load");
    await act(async () => host.querySelector("button")!.click());
    expect(rendered).toBe(2);
    expect(removed).toEqual(["1"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete window.turnstile;
  }
  expect(removed).toEqual(["1", "2"]);
});
