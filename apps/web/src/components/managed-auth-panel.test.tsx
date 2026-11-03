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

test("a team invitation for an unapproved address says the invitation alone can't help", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const setField = async (selector: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(selector);
    if (!input) return;
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
          invitation={{ organizationName: "Acme Labs", targetEmail: "new@example.test" }}
          onSubmit={async () => {
            throw new AuthApiError(
              403,
              "SIGNUP_EMAIL_NOT_ALLOWED",
              null,
              "signup email not allowed",
            );
          }}
        />,
      ),
    );
    await setField("#managed-auth-name", "New Person");
    await setField("#managed-auth-email", "new@example.test");
    await setField('input[type="password"]', "long-enough-password");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const notice = host.querySelector('[data-testid="managed-auth-signup-email-not-allowed"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Ask for your email to be allowed");
    expect(notice!.textContent).toContain(
      "an invitation to Acme Labs doesn't give new@example.test access on its own",
    );
    expect(notice!.textContent).toContain(
      "Ask the admin of this service to allow new@example.test, then open your invitation link again.",
    );
    expect(notice!.textContent).not.toContain("open the invitation link from your email");
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

test("an address that is not approved for the service gets who to ask, not a retry", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const attempts: string[] = [];
  const setField = async (selector: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
    await act(async () => {
      (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({
        target: { value },
      });
    });
  };
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name);
  try {
    await act(async () =>
      root.render(
        <ManagedAuthPanel
          initialMode="signup"
          socialProviders={["google"]}
          onSocialSubmit={async () => undefined}
          onSubmit={async (_mode, input) => {
            attempts.push(input.email);
            throw new AuthApiError(
              403,
              "SIGNUP_EMAIL_NOT_ALLOWED",
              null,
              "signup email not allowed",
            );
          }}
        />,
      ),
    );
    await setField("#managed-auth-name", "New Person");
    await setField("#managed-auth-email", "new@example.test");
    await setField('input[type="password"]', "long-enough-password");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(attempts).toEqual(["new@example.test"]);
    expect(
      host.querySelector('[data-testid="managed-auth-signup-email-not-allowed"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain(
      "new@example.test isn't on this service's list of approved email addresses.",
    );
    expect(host.textContent).toContain(
      "This email can't create an account here. Ask your admin for access.",
    );
    expect(host.textContent).not.toContain("Couldn't create account");
    expect(host.textContent).not.toContain("try again");
    // Nothing to resubmit: no form fields, submit button or provider buttons.
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.querySelector("#managed-auth-email")).toBeNull();
    expect(host.textContent).not.toContain("Google");

    await act(async () => button("Use a different email")!.click());
    expect(host.querySelector('[data-testid="managed-auth-signup-email-not-allowed"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#managed-auth-email")!.value).toBe("");
    expect(host.querySelector('button[type="submit"]')).not.toBeNull();

    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await setField("#managed-auth-email", "other@example.test");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(attempts).toEqual(["new@example.test", "other@example.test"]);
    await act(async () => button("Sign in to an existing account")!.click());
    expect(host.querySelector('[data-testid="managed-auth-signup-email-not-allowed"]')).toBeNull();
    expect(host.querySelector('input[autocomplete="current-password"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("an address the deployment doesn't allow is told it can't sign in, for a password or a passkey", async () =>
  withPasskeyBrowser(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const refusal = () =>
      new AuthApiError(403, "SIGN_IN_EMAIL_NOT_ALLOWED", null, "sign in email not allowed");
    const setField = async (selector: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(selector)!;
      const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
      await act(async () => {
        (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[
          propsKey
        ]!.onChange({ target: { value } });
      });
    };
    const message = "This email can't sign in here. Ask your admin for access.";
    try {
      await act(async () =>
        root.render(
          <ManagedAuthPanel
            passkeySignIn
            onPasskeySubmit={async () => {
              throw refusal();
            }}
            onSubmit={async () => {
              throw refusal();
            }}
          />,
        ),
      );
      await setField("#managed-auth-email", "person@example.test");
      await setField('input[type="password"]', "any-password");
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(host.textContent).toContain("Couldn't sign in");
      expect(host.textContent).toContain(message);
      expect(host.textContent).not.toContain("Please try again");

      const passkey = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Sign in with a passkey",
      )!;
      await act(async () => passkey.click());
      expect(host.textContent).toContain(message);
      expect(host.textContent).not.toContain("Couldn't sign in with your passkey");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }));

function fakeTurnstile() {
  const widgets: Record<string, unknown>[] = [];
  const executed: string[] = [];
  window.turnstile = {
    render: (_element, options) => {
      widgets.push(options);
      return String(widgets.length);
    },
    execute: (id) => {
      executed.push(id);
    },
    remove: () => undefined,
  };
  const call = (index: number, name: string, ...args: unknown[]) =>
    act(async () => {
      (widgets[index]![name] as (...value: unknown[]) => unknown)(...args);
    });
  return { widgets, executed, call };
}

async function mountSocialPanel(
  props: Partial<Parameters<typeof ManagedAuthPanel>[0]> = {},
  onSocial: (provider: string, token?: string) => Promise<void> = async () => undefined,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const starts: Array<[string, string | undefined]> = [];
  await act(async () =>
    root.render(
      <ManagedAuthPanel
        signupChallengeSiteKey="test-key"
        socialProviders={["google", "github"]}
        onSocialSubmit={async (provider, token) => {
          starts.push([provider, token]);
          await onSocial(provider, token);
        }}
        onSubmit={async () => undefined}
        {...props}
      />,
    ),
  );
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!;
  return {
    host,
    starts,
    button,
    click: (name: string) => act(async () => button(name).click()),
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      delete window.turnstile;
    },
  };
}

test("Continue with Google on the Sign in tab gets a challenge token first, then starts the login", async () => {
  const turnstile = fakeTurnstile();
  const panel = await mountSocialPanel();
  try {
    expect(panel.host.textContent).toContain("Welcome back.");
    // Nothing visible: no widget rendered before a click.
    expect(turnstile.widgets).toHaveLength(0);
    await panel.click("Continue with Google");
    expect(turnstile.widgets[0]).toMatchObject({
      action: "signup",
      execution: "execute",
      appearance: "interaction-only",
    });
    expect(turnstile.executed).toEqual(["1"]);
    expect(panel.starts).toEqual([]);
    expect(panel.button("Continue with GitHub").disabled).toBe(true);
    expect(panel.button("Sign up").disabled).toBe(true);
    await turnstile.call(0, "callback", "signin-tab-token");
    expect(panel.starts).toEqual([["google", "signin-tab-token"]]);
    expect(panel.host.textContent).not.toContain("Complete the signup verification");
  } finally {
    await panel.unmount();
  }
});

test("when Cloudflare asks for interaction the challenge shows inline and the login continues once solved", async () => {
  const turnstile = fakeTurnstile();
  const panel = await mountSocialPanel();
  try {
    await panel.click("Continue with GitHub");
    await turnstile.call(0, "before-interactive-callback");
    const widget = panel.host.querySelector('[aria-label="Signup verification"]')!;
    expect(widget.className).toContain("mt-3");
    // The rest of the form stays usable while a person solves it.
    expect(panel.button("Continue with Google").disabled).toBe(false);
    expect(panel.host.querySelector<HTMLInputElement>("#managed-auth-email")!.disabled).toBe(false);
    await turnstile.call(0, "callback", "solved");
    expect(panel.starts).toEqual([["github", "solved"]]);
  } finally {
    await panel.unmount();
  }
});

test("choosing something else while the challenge waits for a person cancels the click", async () => {
  const turnstile = fakeTurnstile();
  const panel = await mountSocialPanel();
  try {
    await panel.click("Continue with Google");
    await turnstile.call(0, "before-interactive-callback");
    await panel.click("Sign up");
    await turnstile.call(0, "callback", "too-late");
    expect(panel.starts).toEqual([]);
    expect(panel.host.textContent).toContain("Create account");
    expect(panel.button("Continue with Google").disabled).toBe(false);
  } finally {
    await panel.unmount();
  }
});

test("a challenge that can't produce a token still lets an existing person continue", async () => {
  const turnstile = fakeTurnstile();
  let fail = true;
  const panel = await mountSocialPanel({}, async () => {
    if (fail) throw new Error("provider unavailable");
  });
  try {
    await panel.click("Continue with Google");
    await turnstile.call(0, "error-callback", "600010");
    expect(panel.starts).toEqual([["google", undefined]]);
    // A provider start failure is reported and the buttons come back.
    expect(panel.host.textContent).toContain("Couldn't continue with Google. Try again.");
    expect(panel.button("Continue with Google").disabled).toBe(false);
    fail = false;
    await panel.click("Continue with Google");
    await turnstile.call(1, "callback", "retry-token");
    expect(panel.starts.at(-1)).toEqual(["google", "retry-token"]);
  } finally {
    await panel.unmount();
  }
});

test("the Sign up tab uses its solved visible challenge, or runs one in the background", async () => {
  const turnstile = fakeTurnstile();
  let panel = await mountSocialPanel({ initialMode: "signup" });
  try {
    // The visible widget for email sign-up is unchanged.
    expect(turnstile.widgets).toHaveLength(1);
    expect(turnstile.widgets[0]!.execution).toBeUndefined();
    await panel.click("Continue with GitHub");
    expect(panel.host.textContent).not.toContain("Complete the signup verification");
    expect(turnstile.widgets[1]).toMatchObject({ execution: "execute" });
    await turnstile.call(1, "callback", "background-token");
    expect(panel.starts).toEqual([["github", "background-token"]]);
    await panel.unmount();

    const next = fakeTurnstile();
    panel = await mountSocialPanel({ initialMode: "signup" });
    await next.call(0, "callback", "visible-token");
    await panel.click("Continue with Google");
    expect(next.widgets).toHaveLength(1);
    expect(panel.starts).toEqual([["google", "visible-token"]]);
  } finally {
    await panel.unmount();
  }
});

test("while new accounts are paused, or without a site key, social sign-in runs no challenge", async () => {
  for (const props of [{ newSignupsEnabled: false }, { signupChallengeSiteKey: undefined }]) {
    const turnstile = fakeTurnstile();
    const panel = await mountSocialPanel(props);
    try {
      await panel.click("Continue with Google");
      expect(turnstile.widgets).toHaveLength(0);
      expect(panel.starts).toEqual([["google", undefined]]);
    } finally {
      await panel.unmount();
    }
  }
});
