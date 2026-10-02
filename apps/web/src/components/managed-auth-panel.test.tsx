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

test("paused sign-ups replace the sign-up form and social buttons with a capacity message", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const submits: string[] = [];
  const socialStarts: string[] = [];
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name);
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          initialMode="signup"
          newSignupsEnabled={false}
          socialProviders={["google", "github"]}
          onSocialSubmit={async (provider) => {
            socialStarts.push(provider);
          }}
          onSubmit={async (mode) => {
            submits.push(mode);
          }}
        />,
      ),
    );
    const paused = host.querySelector('[data-testid="managed-auth-signups-paused"]');
    expect(paused?.textContent).toContain(
      "We're at capacity for new accounts right now. Please try again later.",
    );
    expect(paused?.querySelector('[role="status"]')).not.toBeNull();
    // No way to create an account from this screen: no fields, no submit, no
    // Google/GitHub buttons (an unknown provider account would be a sign-up).
    expect(host.querySelector("#managed-auth-name")).toBeNull();
    expect(host.querySelector("#managed-auth-email")).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Google|GitHub/);
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(submits).toEqual([]);

    // Sign-in stays available, including the social buttons for existing accounts.
    await act(async () => button("Sign in to an existing account")!.click());
    expect(host.querySelector('[data-testid="managed-auth-signups-paused"]')).toBeNull();
    expect(host.querySelector("#managed-auth-email")).not.toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.textContent).toContain("Google");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    // Empty fields fail validation locally; the point is the form is live again.
    expect(host.textContent).toContain("Enter your email address.");

    // The Sign up tab still explains the pause rather than hiding it.
    await act(async () => button("Sign up")!.click());
    expect(host.querySelector('[data-testid="managed-auth-signups-paused"]')).not.toBeNull();
    expect(socialStarts).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a signup-only registration panel shows the pause without an in-panel sign-in action", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          initialMode="signup"
          allowedModes={["signup"]}
          presentation="embedded"
          newSignupsEnabled={false}
          onSubmit={async () => {
            throw new Error("must not sign up");
          }}
        />,
      ),
    );
    expect(host.querySelector('[data-testid="managed-auth-signups-paused"]')).not.toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).not.toContain("Sign in to an existing account");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("an invited person on the paused sign-up screen is pointed back to their invitation link", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          initialMode="signup"
          newSignupsEnabled={false}
          invitation={{ organizationName: "Acme Labs", targetEmail: "new@example.test" }}
          onSubmit={async () => {
            throw new Error("must not sign up");
          }}
        />,
      ),
    );
    expect(host.textContent).toContain(
      "To join Acme Labs, open the invitation link from your email to set up your account.",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
