import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ManagedAuthSessionSetProjection } from "@opengeni/sdk/accounts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { storeOrganizationInvitationContinuation } from "@/lib/organization-invitation-continuation";

import { AccountAuthRoute } from "./account-auth";

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
    sessionStorage.clear();
    storeOrganizationInvitationContinuation({
      organizationId: "00000000-0000-4000-8000-000000000010",
      organizationName: "Northwind Research",
      targetEmail: "invited@example.test",
      expiresAt: "2026-09-08T12:00:00.000Z",
    });
    Object.defineProperty(window, "opener", { configurable: true, value: window });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AccountAuthRoute transactionId={TRANSACTION_ID} />));
      const email = container.querySelector<HTMLInputElement>("#account-auth-email")!;
      expect(email.value).toBe("invited@example.test");
      expect(email.readOnly).toBeTrue();
      expect(container.textContent).toContain(
        "Sign in as invited@example.test to continue joining Northwind Research",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
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
});
