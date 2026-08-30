import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { RigOverview } from "@/components/rigs/rig-overview";
import { deferredRigVerificationView } from "@/lib/rig-status";
import type { Rig, RigVersion } from "@/types";
import { RigScopeChip } from "./rigs";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("Rigs access scope", () => {
  test("distinguishes personal, workspace, and organization rigs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      for (const [scope, label] of [
        ["user", "Only me"],
        ["workspace", "Workspace"],
        ["organization", "Organization"],
      ] as const) {
        await act(async () => root.render(<RigScopeChip scope={scope} />));
        expect(container.querySelector(`[data-rig-scope="${scope}"]`)?.textContent).toBe(label);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("surfaces safe pending-version recovery without suggesting duplicate creation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const first = pendingVersion("11111111-1111-4111-8111-111111111111", 1);
    let recoveries = 0;
    try {
      await act(async () =>
        root.render(
          <RigOverview
            rig={inactiveRig()}
            changes={[]}
            variableSetName={() => "Variable set"}
            canUse
            mutating={false}
            deferredVerification={deferredRigVerificationView([first])}
            onRecoverDeferred={async () => {
              recoveries += 1;
              return { ok: true, versionId: first.id };
            }}
            onVerify={async () => null}
          />,
        ),
      );
      expect(container.textContent).toContain("Resume verification");
      expect(container.textContent).toContain("without creating a second Rig");
      expect(container.textContent?.toLowerCase()).not.toContain("retry creating");
      const button = [...container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes("Resume verification"),
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(recoveries).toBe(1);

      const second = pendingVersion("22222222-2222-4222-8222-222222222222", 2);
      await act(async () =>
        root.render(
          <RigOverview
            rig={inactiveRig()}
            changes={[]}
            variableSetName={() => "Variable set"}
            canUse
            mutating={false}
            deferredVerification={deferredRigVerificationView([first, second])}
            onRecoverDeferred={async () => {
              recoveries += 1;
              return null;
            }}
            onVerify={async () => null}
          />,
        ),
      );
      expect(container.textContent).toContain(
        "A Rig manager must choose and verify the exact version",
      );
      expect(
        [...container.querySelectorAll("button")].some((candidate) =>
          candidate.textContent?.includes("Resume verification"),
        ),
      ).toBe(false);
      expect(recoveries).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function inactiveRig(): Rig {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    accountId: "44444444-4444-4444-8444-444444444444",
    workspaceId: "55555555-5555-4555-8555-555555555555",
    scope: "workspace",
    generation: 1,
    status: "active",
    name: "Deferred Rig",
    description: null,
    createdBy: "user:test",
    activeVersion: null,
    activeVersionHealth: null,
    versionCount: 2,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
}

function pendingVersion(id: string, version: number): RigVersion {
  return {
    id,
    rigId: "33333333-3333-4333-8333-333333333333",
    version,
    image: null,
    setupScript: null,
    checks: [],
    credentialHooks: [],
    defaultVariableSetIds: [],
    changelog: null,
    providerImages: {},
    createdBy: "user:test",
    active: false,
    verificationStatus: "pending",
    createdAt: "2026-08-30T12:00:00.000Z",
  };
}
