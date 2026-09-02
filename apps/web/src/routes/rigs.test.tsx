import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { RigOverview } from "@/components/rigs/rig-overview";
import { RigSetupSection } from "@/components/rigs/rig-setup-section";
import { RigVersionsTimeline } from "@/components/rigs/rig-versions-timeline";
import { deferredRigVerificationView } from "@/lib/rig-status";
import type { CreateRigVersionRequest, Rig, RigVersion } from "@/types";
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
            versionsLoading={false}
            versionsError={null}
            onRetryVersions={() => undefined}
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
            versionsLoading={false}
            versionsError={null}
            onRetryVersions={() => undefined}
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

  test("gives managers exact pending/failed version actions and hides them from non-managers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pending = pendingVersion("11111111-1111-4111-8111-111111111111", 1);
    const failed = {
      ...pendingVersion("22222222-2222-4222-8222-222222222222", 2),
      verificationStatus: "failed" as const,
    };
    const verified: string[] = [];
    try {
      await act(async () =>
        root.render(
          <RigVersionsTimeline
            versions={[pending, failed]}
            activeVersionId={null}
            variableSetName={() => "Variable set"}
            canManage
            mutating={false}
            deferredVerification={deferredRigVerificationView([pending, failed])}
            onRecoverDeferred={async () => null}
            onVerifyVersion={async (versionId) => {
              verified.push(versionId);
              return { ok: true, versionId };
            }}
            onActivate={async () => null}
          />,
        ),
      );
      expect(container.textContent).toContain("Verify");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).not.toContain("Resume verification");
      const buttons = [...container.querySelectorAll("button")];
      const verify = buttons.find((button) => button.textContent?.trim() === "Verify");
      const retry = buttons.find((button) => button.textContent?.trim() === "Retry");
      expect(verify).toBeDefined();
      expect(retry).toBeDefined();
      await act(async () => {
        verify!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(verified).toEqual([pending.id, failed.id]);

      await act(async () =>
        root.render(
          <RigVersionsTimeline
            versions={[pending, failed]}
            activeVersionId={null}
            variableSetName={() => "Variable set"}
            canManage={false}
            mutating={false}
            deferredVerification={deferredRigVerificationView([pending, failed])}
            onRecoverDeferred={async () => null}
            onVerifyVersion={async () => null}
            onActivate={async () => null}
          />,
        ),
      );
      expect(
        [...container.querySelectorAll("button")].some((button) =>
          ["Verify", "Retry"].includes(button.textContent?.trim() ?? ""),
        ),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps unavailable version history in loading/error state with a retry", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let retries = 0;
    try {
      await act(async () =>
        root.render(
          <RigOverview
            rig={inactiveRig()}
            changes={[]}
            variableSetName={() => "Variable set"}
            canUse
            mutating={false}
            deferredVerification={null}
            versionsLoading
            versionsError={null}
            onRetryVersions={() => {
              retries += 1;
            }}
            onRecoverDeferred={async () => null}
            onVerify={async () => null}
          />,
        ),
      );
      expect(container.textContent).toContain("Loading version recovery state");
      expect(container.textContent).not.toContain("no active version");

      await act(async () =>
        root.render(
          <RigOverview
            rig={inactiveRig()}
            changes={[]}
            variableSetName={() => "Variable set"}
            canUse
            mutating={false}
            deferredVerification={null}
            versionsLoading={false}
            versionsError={new Error("network unavailable")}
            onRetryVersions={() => {
              retries += 1;
            }}
            onRecoverDeferred={async () => null}
            onVerify={async () => null}
          />,
        ),
      );
      expect(container.textContent).toContain("Couldn't load version recovery state");
      expect(container.textContent).not.toContain("No deferred pending attempt");
      const retry = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(retries).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("creates a manager replacement from an exact inactive base with a null active-version CAS", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const base = pendingVersion("66666666-6666-4666-8666-666666666666", 7);
    base.setupScript = "echo historical";
    base.checks = [{ name: "bun", command: "bun --version" }];
    const submitted: CreateRigVersionRequest[] = [];
    try {
      await act(async () =>
        root.render(
          <RigSetupSection
            activeVersion={null}
            versions={[base]}
            versionsLoading={false}
            versionsError={null}
            rigScope="workspace"
            variableSets={[]}
            canPropose={false}
            canManage
            mutating={false}
            onPropose={async () => null}
            onProposed={() => undefined}
            onCreateVersion={async (request) => {
              submitted.push(request);
              return { ok: true };
            }}
            onRetryVersions={() => undefined}
          />,
        ),
      );
      expect(container.textContent).toContain("Create a replacement version");
      expect(container.textContent).toContain("cannot overwrite a version activated");

      const baseSelect = container.querySelector<HTMLSelectElement>("#replacement-rig-base");
      expect(baseSelect).not.toBeNull();
      await act(async () => {
        baseSelect!.value = base.id;
        baseSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelector<HTMLTextAreaElement>("#replacement-rig-setup")?.disabled).toBe(
        true,
      );

      const create = [...container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes("Create and verify replacement"),
      );
      expect(create).toBeDefined();
      await act(async () => {
        create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(submitted).toEqual([
        {
          expectedActiveVersionId: null,
          baseVersionId: base.id,
        },
      ]);
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
