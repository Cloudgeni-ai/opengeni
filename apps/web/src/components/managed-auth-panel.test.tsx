import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ManagedAuthPanel } from "./managed-auth-panel";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("password recovery validates email, posts no password, and keeps failures retryable", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  let fail = true;
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(fail ? { message: "Unavailable" } : { status: true }), {
      status: fail ? 503 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!;
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          onSubmit={async () => {
            throw new Error("must not sign in");
          }}
        />,
      ),
    );
    await act(async () => button("Forgot password?").click());
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests).toHaveLength(0);
    expect(host.textContent).toContain("Enter your email address.");
    const input = host.querySelector<HTMLInputElement>("#managed-auth-email")!;
    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
    await act(async () => {
      (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({
        target: { value: "member@example.test" },
      });
    });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain("We couldn't request a password reset.");
    fail = false;
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests[1]).toEqual({
      url: expect.stringContaining("/v1/auth/request-password-reset"),
      body: { email: "member@example.test", redirectTo: "/reset-password" },
    });
    expect(host.textContent).toContain("If this email has an account");
    await act(async () => button("Back to sign in").click());
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.textContent).not.toContain("If this email has an account");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    host.remove();
  }
});
