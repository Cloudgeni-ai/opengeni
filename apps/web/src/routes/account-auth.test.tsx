import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  BrowserAccountsApiError,
  type ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { storeOrganizationInvitationContinuation } from "@/lib/organization-invitation-continuation";

import { SIGN_IN_EMAIL_NOT_ALLOWED_MESSAGE } from "@/lib/signups-paused";

import { AccountAuthRoute, accountAuthFailureMessage } from "./account-auth";

const TRANSACTION_ID = "00000000-0000-4000-8000-000000000001";
const SLOT_ID = "00000000-0000-4000-8000-000000000002";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function projection(generation: string): ManagedAuthSessionSetProjection {
  return {
    mode: "broker",
    generation,
    actorEpoch: "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: null,
    state: "actor_change_required",
    slots:
      generation === "1"
        ? []
        : [
            {
              id: SLOT_ID,
              displayName: "Account Beta",
              verifiedClaim: { kind: "email", value: "beta@example.test" },
              state: "active",
            },
          ],
  };
}

async function enter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey!]!.onChange;
    onChange!({ target: input });
  });
}

async function flush(): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("isolated browser account authentication", () => {
  test("prefills and locks the invited email from the same-origin opener", async () => {
    const originalOpener = Object.getOwnPropertyDescriptor(window, "opener");
    const originalFetch = globalThis.fetch;
    sessionStorage.clear();
    storeOrganizationInvitationContinuation({
      organizationId: "00000000-0000-4000-8000-000000000010",
      organizationName: "Northwind Research",
      targetEmail: "invited@example.test",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    Object.defineProperty(window, "opener", { configurable: true, value: window });
    globalThis.fetch = (async () =>
      Response.json({
        auth: {
          mode: "managedSession",
          session: "cookie",
          socialProviders: ["google", "github"],
        },
      })) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      await flush();
      const email = container.querySelector<HTMLInputElement>("#account-auth-email")!;
      expect(email.value).toBe("invited@example.test");
      expect(email.readOnly).toBeTrue();
      expect(container.textContent).toContain(
        "Sign in as invited@example.test to continue joining Northwind Research",
      );
      expect(container.textContent).not.toContain("Continue with Google");
      expect(container.textContent).not.toContain("Continue with GitHub");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      globalThis.fetch = originalFetch;
      if (originalOpener) Object.defineProperty(window, "opener", originalOpener);
      else Reflect.deleteProperty(window, "opener");
    }
  });

  test("replays an outcome-unknown completion with its original command generation", async () => {
    const originalFetch = globalThis.fetch;
    const mutationBodies: Array<Record<string, unknown>> = [];
    let reads = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      if (new URL(url, "https://opengeni.test").pathname === "/v1/config/client") {
        return Response.json({
          auth: { mode: "managedSession", session: "cookie", socialProviders: [] },
        });
      }
      if ((init?.method ?? "GET") === "GET") {
        reads += 1;
        return Response.json(projection(reads === 1 ? "1" : "2"));
      }
      mutationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new TypeError("response lost after commit");
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      const email = container.querySelector<HTMLInputElement>("#account-auth-email")!;
      const password = container.querySelector<HTMLInputElement>("#account-auth-password")!;
      await enter(email, "beta@example.test");
      await enter(password, "correct horse battery staple");
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      await flush();

      await enter(password, "correct horse battery staple");
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      await flush();

      expect(reads).toBe(2);
      expect(mutationBodies).toHaveLength(2);
      expect(mutationBodies[1]).toEqual(mutationBodies[0]);
      expect(mutationBodies[0]?.expectedGeneration).toBe("1");
      expect(mutationBodies[0]?.operationId).toBeString();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  });

  test("says an address isn't allowed instead of asking to check the credentials", async () => {
    const originalFetch = globalThis.fetch;
    const refusals = [
      { status: 403, code: "sign_in_email_not_allowed" },
      { status: 401, code: "invalid_credentials" },
    ];
    let attempt = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      if (new URL(url, "https://opengeni.test").pathname === "/v1/config/client") {
        return Response.json({
          auth: { mode: "managedSession", session: "cookie", socialProviders: [] },
        });
      }
      if ((init?.method ?? "GET") === "GET") return Response.json(projection("1"));
      const refusal = refusals[attempt++]!;
      return Response.json(
        {
          error: {
            status: refusal.status,
            code: refusal.status === 401 ? "unauthenticated" : "forbidden",
            message: refusal.code,
            retryable: false,
            details: { managedAuthCode: refusal.code },
          },
        },
        { status: refusal.status },
      );
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      const email = container.querySelector<HTMLInputElement>("#account-auth-email")!;
      const password = container.querySelector<HTMLInputElement>("#account-auth-password")!;
      const submit = async () => {
        await enter(email, "removed@example.test");
        await enter(password, "correct horse battery staple");
        await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
        await flush();
        return container.querySelector('[role="alert"]')?.textContent;
      };

      expect(await submit()).toBe("This email can't sign in here. Ask your admin for access.");
      expect(await submit()).toBe(
        "Authentication did not complete. Check the credentials and try again.",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  });

  test("Google gets a background challenge token without a Create a new account switch", async () => {
    const originalFetch = globalThis.fetch;
    const socialBodies: Array<Record<string, unknown>> = [];
    const widgets: Record<string, unknown>[] = [];
    let socialReplies = 0;
    window.turnstile = {
      render: (_element, options) => {
        widgets.push(options);
        return String(widgets.length);
      },
      execute: () => undefined,
      remove: () => undefined,
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      if (new URL(url, "https://opengeni.test").pathname === "/v1/config/client") {
        return Response.json({
          auth: {
            mode: "managedSession",
            session: "cookie",
            socialProviders: ["google"],
            signupChallengeSiteKey: "test-key",
          },
        });
      }
      if ((init?.method ?? "GET") === "GET") return Response.json(projection("1"));
      socialBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      socialReplies++;
      // The first start loses its response; the retry must replay the same command.
      if (socialReplies === 1) throw new TypeError("response lost after commit");
      return Response.json({ code: "unavailable", message: "unavailable" }, { status: 503 });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const google = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Continue with Google"),
      )!;
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      await flush();
      expect(container.textContent).not.toContain("Create a new account");
      expect(container.querySelector('[role="switch"]')).toBeNull();
      expect(widgets).toHaveLength(0);

      await act(async () => google().click());
      expect(widgets[0]).toMatchObject({ execution: "execute", appearance: "interaction-only" });
      expect(socialBodies).toHaveLength(0);
      await act(async () => (widgets[0]!.callback as (token: string) => void)("popup-token"));
      await flush();
      expect(socialBodies).toHaveLength(1);
      expect(socialBodies[0]).toMatchObject({
        provider: "google",
        signupChallengeToken: "popup-token",
        expectedGeneration: "1",
      });

      await act(async () => google().click());
      await flush();
      expect(widgets).toHaveLength(1);
      expect(socialBodies[1]).toEqual(socialBodies[0]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
      delete window.turnstile;
    }
  });

  test("an email sign-in while the challenge waits for a person cancels the Google click", async () => {
    const originalFetch = globalThis.fetch;
    const posts: Array<Record<string, unknown>> = [];
    const widgets: Record<string, unknown>[] = [];
    window.turnstile = {
      render: (_element, options) => {
        widgets.push(options);
        return String(widgets.length);
      },
      execute: () => undefined,
      remove: () => undefined,
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      if (new URL(url, "https://opengeni.test").pathname === "/v1/config/client") {
        return Response.json({
          auth: {
            mode: "managedSession",
            session: "cookie",
            socialProviders: ["google"],
            signupChallengeSiteKey: "test-key",
          },
        });
      }
      if ((init?.method ?? "GET") === "GET") return Response.json(projection("1"));
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ code: "unavailable", message: "unavailable" }, { status: 503 });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const google = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Continue with Google"),
      )!;
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      await flush();
      await act(async () => google().click());
      await act(async () => (widgets[0]!["before-interactive-callback"] as () => void)());
      // While a person solves the challenge, the email form stays usable.
      const email = container.querySelector<HTMLInputElement>("#account-auth-email")!;
      const password = container.querySelector<HTMLInputElement>("#account-auth-password")!;
      expect(email.disabled).toBe(false);
      await enter(email, "existing@example.test");
      await enter(password, "correct horse battery staple");
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      await flush();
      await act(async () => (widgets[0]!.callback as (token: string) => void)("too-late"));
      await flush();
      expect(posts.some((body) => body.provider === "google")).toBe(false);
      expect(posts.length).toBeGreaterThan(0);
      expect(google().disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
      delete window.turnstile;
    }
  });
});

describe("add-account failure messages", () => {
  const generic = "Authentication did not complete. Check the credentials and try again.";

  test("each refusal the server names gets its own message", () => {
    const message = (status: number, code: string) =>
      accountAuthFailureMessage(new BrowserAccountsApiError(status, code));
    expect(message(403, "sign_in_email_not_allowed")).toBe(SIGN_IN_EMAIL_NOT_ALLOWED_MESSAGE);
    expect(message(403, "email_not_verified")).toBe("Verify your email before signing in.");
    expect(message(403, "sign_in_refused")).toBe("This account can't sign in right now.");
    expect(message(429, "login_transaction_rate_limited")).toBe(
      "Too many attempts. Wait a while, then try again.",
    );
  });

  test("wrong credentials and unexpected failures keep the generic message", () => {
    expect(accountAuthFailureMessage(new BrowserAccountsApiError(401, "invalid_credentials"))).toBe(
      generic,
    );
    expect(accountAuthFailureMessage(new BrowserAccountsApiError(500, "internal_error"))).toBe(
      generic,
    );
    expect(accountAuthFailureMessage(new Error("network down"))).toBe(generic);
  });
});
