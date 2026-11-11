import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  BrowserAccountsProvider,
  useBrowserAccounts,
  type BrowserAccountsContextValue,
} from "@opengeni/react/accounts";
import type {
  BrowserAccountsClientLike,
  ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { BrowserAccountsLoadingGate } from "./browser-accounts-runtime";
import { useBrowserActorGeneration } from "./browser-actor-generation";

const FIRST_SLOT = "00000000-0000-4000-8000-000000000001";
const SECOND_SLOT = "00000000-0000-4000-8000-000000000002";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function projection(
  generation: number,
  actorEpoch: number,
  selectedSlotId: string | null,
): ManagedAuthSessionSetProjection {
  return {
    mode: "broker",
    generation: String(generation),
    actorEpoch: String(actorEpoch),
    csrfToken: "c".repeat(43),
    selectedSlotId,
    state: "ready",
    slots: [FIRST_SLOT, SECOND_SLOT].map((id, index) => ({
      id,
      displayName: `Account ${index + 1}`,
      verifiedClaim: { kind: "email", value: `account-${index + 1}@example.test` },
      state: "active",
    })),
  };
}

async function flush(): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("browser actor generation (#6248)", () => {
  test("keeps a keyed recorder across a same-person reload and remounts it on a real actor change", async () => {
    let authority = projection(1, 1, FIRST_SLOT);
    let holdNextReconcile = false;
    let release: (() => void) | null = null;
    const client: BrowserAccountsClientLike = {
      getSessionSet: async () => authority,
      reconcileSessionSetAuthority: async () => {
        if (holdNextReconcile) {
          holdNextReconcile = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return authority;
      },
      bootstrapSessionSet: async () => authority,
      beginLoginTransaction: async () => {
        throw new Error("not used");
      },
      completeEmailPasswordTransaction: async () => {
        throw new Error("not used");
      },
      cancelLoginTransaction: async () => authority,
      selectLoginSlot: async () => authority,
      logoutLoginSlot: async () => authority,
      logoutSessionSet: async () => ({ generation: "9", actorEpoch: "9", state: "logged_out" }),
      resolveDeepLink: async () => ({ kind: "unavailable" }),
    };

    let mounts = 0;
    let unmounts = 0;
    let accounts: BrowserAccountsContextValue | null = null;
    function Recorder({ children }: { children: ReactNode }) {
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return <div data-recorder="true">{children}</div>;
    }
    function Accounts() {
      accounts = useBrowserAccounts();
      return null;
    }
    function Harness() {
      const [generation, onActorTransition] = useBrowserActorGeneration(async () => undefined);
      return (
        <BrowserAccountsProvider
          client={client}
          broadcastChannelName={null}
          onActorTransition={onActorTransition}
        >
          <Accounts />
          <Recorder key={generation}>
            <BrowserAccountsLoadingGate>
              <span data-signed-in="true">Signed in</span>
            </BrowserAccountsLoadingGate>
          </Recorder>
        </BrowserAccountsProvider>
      );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(container.querySelector('[data-signed-in="true"]')).not.toBeNull();
      const settledMounts = mounts;
      const settledUnmounts = unmounts;

      // Re-signing in reloads the same person: the gate shows its loading
      // panel, but the recorder above it stays mounted.
      authority = projection(2, 1, FIRST_SLOT);
      holdNextReconcile = true;
      let reloaded: Promise<unknown> = Promise.resolve();
      await act(async () => {
        reloaded = accounts!.refresh();
      });
      await flush();
      expect(accounts!.phase).toBe("loading");
      expect(container.querySelector('[data-signed-in="true"]')).toBeNull();
      expect(container.querySelector('[data-recorder="true"]')).not.toBeNull();
      await act(async () => {
        release!();
        await reloaded;
      });
      await flush();
      expect(container.querySelector('[data-signed-in="true"]')).not.toBeNull();
      expect(mounts).toBe(settledMounts);
      expect(unmounts).toBe(settledUnmounts);

      // Another account: the recorder is remounted, ending its recording.
      authority = projection(3, 2, SECOND_SLOT);
      await act(async () => {
        await accounts!.refresh();
      });
      await flush();
      expect(unmounts).toBeGreaterThan(settledUnmounts);
      expect(mounts).toBeGreaterThan(settledMounts);

      // Signing out remounts it again.
      const switchedUnmounts = unmounts;
      authority = projection(4, 3, null);
      await act(async () => {
        await accounts!.refresh();
      });
      await flush();
      expect(unmounts).toBeGreaterThan(switchedUnmounts);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
