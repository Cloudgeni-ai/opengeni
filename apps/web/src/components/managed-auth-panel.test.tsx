import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AuthApiError } from "@/api";
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

test("a tab opened before an operator paused sign-ups switches to the paused view on refusal", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const setField = async (selector: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
    await act(async () => {
      (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({
        target: { value },
      });
    });
  };
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          initialMode="signup"
          onSubmit={async () => {
            throw new AuthApiError(
              403,
              "NEW_SIGNUPS_PAUSED",
              null,
              "We're at capacity for new accounts right now. Please try again later.",
            );
          }}
        />,
      ),
    );
    expect(host.querySelector('[data-testid="managed-auth-signups-paused"]')).toBeNull();
    await setField("#managed-auth-name", "New Person");
    await setField("#managed-auth-email", "new@example.test");
    await setField('input[type="password"]', "long-enough-password");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector('[data-testid="managed-auth-signups-paused"]')).not.toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).not.toContain("Couldn't create account");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function withPasskeyBrowser<T>(run: () => Promise<T>): Promise<T> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = scope.PublicKeyCredential;
  scope.PublicKeyCredential = function PublicKeyCredential() {};
  if (!navigator.credentials) {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: async () => null, create: async () => null },
    });
  }
  return run().finally(() => {
    scope.PublicKeyCredential = previous;
  });
}

test("signs in with a passkey and explains a dismissed prompt without blaming the person", async () =>
  withPasskeyBrowser(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls: Array<{ mode: string; input: unknown }> = [];
    let dismiss = true;
    const button = (name: string) =>
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name);
    try {
      await act(async () =>
        root.render(
          <ManagedAuthPanel
            passkeySignIn
            onPasskeySubmit={async (mode, input) => {
              calls.push({ mode, input });
              if (dismiss) throw new DOMException("The operation was cancelled", "NotAllowedError");
            }}
            onSubmit={async () => {
              throw new Error("must not use a password");
            }}
          />,
        ),
      );
      await act(async () => button("Sign in with a passkey")!.click());
      expect(calls).toEqual([{ mode: "signin", input: undefined }]);
      expect(host.textContent).toContain("No passkey was used.");
      dismiss = false;
      await act(async () => button("Sign in with a passkey")!.click());
      expect(calls).toHaveLength(2);
      expect(host.textContent).not.toContain("No passkey was used.");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }));

test("creates an account with only a name and a passkey, and offers sign-in for a known passkey", async () =>
  withPasskeyBrowser(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls: Array<{ mode: string; input: unknown }> = [];
    const button = (name: string) =>
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name);
    const submit = () =>
      act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    try {
      await act(async () =>
        root.render(
          <ManagedAuthPanel
            initialMode="signup"
            passkeySignIn
            passkeySignUp
            onPasskeySubmit={async (mode, input) => {
              calls.push({ mode, input });
              throw new AuthApiError(
                409,
                "PASSKEY_ALREADY_REGISTERED",
                null,
                "This passkey already belongs to an account; sign in with it",
              );
            }}
            onSubmit={async () => {
              throw new Error("must not use email");
            }}
          />,
        ),
      );
      expect(host.querySelector("#managed-auth-email")).not.toBeNull();
      await act(async () => button("Create account with a passkey")!.click());
      // Name only: no email address or password is asked for.
      expect(host.querySelector("#managed-auth-email")).toBeNull();
      expect(host.querySelector('input[type="password"]')).toBeNull();
      expect(host.querySelector("#managed-auth-name")).not.toBeNull();
      await submit();
      expect(calls).toHaveLength(0);
      expect(host.textContent).toContain("Enter your name.");
      const input = host.querySelector<HTMLInputElement>("#managed-auth-name")!;
      const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
      await act(async () => {
        (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[
          propsKey
        ]!.onChange({ target: { value: "  Ada Lovelace  " } });
      });
      await submit();
      expect(calls).toEqual([{ mode: "signup", input: { name: "Ada Lovelace" } }]);
      expect(host.textContent).toContain("This passkey already belongs to an account here.");
      await act(async () => button("Sign in")!.click());
      expect(button("Sign in with a passkey")).toBeDefined();
      await act(async () => button("Sign up")!.click());
      await act(async () => button("Create account with a passkey")!.click());
      await act(async () => button("Use email instead")!.click());
      expect(host.querySelector("#managed-auth-email")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }));

test("offers no passkeys where the deployment or the browser can't use them", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          passkeySignIn
          passkeySignUp
          onPasskeySubmit={async () => undefined}
          onSubmit={async () => undefined}
        />,
      ),
    );
    // This test browser has no WebAuthn.
    expect(host.textContent).not.toContain("passkey");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
