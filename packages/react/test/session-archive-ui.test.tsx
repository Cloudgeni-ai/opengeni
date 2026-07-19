import { afterEach, describe, expect, test } from "bun:test";
import type {
  SessionArchiveAction,
  SessionArchiveApplyRequest,
  SessionArchiveApplyResponse,
  SessionArchivePlanRequest,
  SessionArchivePlanResponse,
  SessionArchiveProjection,
} from "@opengeni/sdk";
import { act } from "react";
import type { SessionClientLike } from "../src/client";
import { SessionArchiveBanner, SessionArchiveDialog } from "../src/components/session-archive";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const CHILD_ID = "33333333-3333-4333-8333-333333333333";
const SEAL_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_SEAL_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const MANIFEST_CHECKSUM = `sha256:${"a".repeat(64)}`;
const ROOT_CHECKSUM = `sha256:${"b".repeat(64)}`;
const COVERAGE_CHECKSUM = `sha256:${"c".repeat(64)}`;

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  document.body.replaceChildren();
});

function planFixture(
  action: SessionArchiveAction,
  options: {
    targetSealId?: string | null;
    canApply?: boolean;
    workspaceId?: string;
  } = {},
): SessionArchivePlanResponse {
  const targetSealId = action === "unarchive" ? (options.targetSealId ?? SEAL_ID) : null;
  const blockers =
    options.canApply === false
      ? [
          {
            code: "goal_active" as const,
            sessionId: SESSION_ID,
            resourceId: "goal-1",
            state: "active",
            details: {},
          },
          {
            code: "sandbox_lease_exclusive" as const,
            sessionId: CHILD_ID,
            resourceId: "lease-1",
            state: "warm",
            details: {},
          },
        ]
      : [];
  const canApply = blockers.length === 0;
  return {
    manifest: {
      format: "opengeni.session-archive-manifest",
      version: 1,
      workspaceId: options.workspaceId ?? WORKSPACE_ID,
      action,
      totalMemberCount: 2,
      roots: [
        {
          rootSessionId: SESSION_ID,
          targetSealId,
          memberCount: 2,
          members: [
            {
              sessionId: SESSION_ID,
              parentSessionId: null,
              depth: 0,
              expectedArchiveRevision: "7",
              expectedArchived: action === "unarchive",
            },
            {
              sessionId: CHILD_ID,
              parentSessionId: SESSION_ID,
              depth: 1,
              expectedArchiveRevision: "3",
              expectedArchived: action === "unarchive",
            },
          ],
        },
      ],
    },
    manifestChecksum: MANIFEST_CHECKSUM,
    canApply,
    roots: [
      {
        rootSessionId: SESSION_ID,
        targetSealId,
        rootChecksum: ROOT_CHECKSUM,
        memberCount: 2,
        canApply,
        blockers,
      },
    ],
  };
}

function applyFixture(
  action: SessionArchiveAction,
  rootArchive: SessionArchiveProjection,
  operationKey = "operation-key",
): SessionArchiveApplyResponse {
  return {
    receipt: {
      id: RECEIPT_ID,
      workspaceId: WORKSPACE_ID,
      action,
      operationKey,
      manifestChecksum: MANIFEST_CHECKSUM,
      rootChecksum: ROOT_CHECKSUM,
      rootSessionId: SESSION_ID,
      sealId: SEAL_ID,
      memberCount: 2,
      coverageChecksum: COVERAGE_CHECKSUM,
      committedAt: "2026-07-19T00:00:00.000Z",
    },
    replay: false,
    rootArchive,
  };
}

const archivedProjection: SessionArchiveProjection = {
  archived: true,
  archiveRevision: "8",
  activeSealCount: 1,
  archivedAt: "2026-07-19T00:00:00.000Z",
  nearestFence: {
    sessionId: SESSION_ID,
    rootSessionId: SESSION_ID,
    sealId: OTHER_SEAL_ID,
    archiveRevision: "8",
  },
};

const liveProjection: SessionArchiveProjection = {
  archived: false,
  archiveRevision: "8",
  activeSealCount: 0,
  archivedAt: null,
  nearestFence: null,
};

describe("SessionArchiveDialog", () => {
  test("plans one recursive root, traps focus, and restores focus on Escape", async () => {
    const requests: SessionArchivePlanRequest[] = [];
    const client = fakeClient({
      planSessionArchive: async (_workspaceId, request) => {
        requests.push(request);
        return planFixture("archive");
      },
    });
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    const openChanges: boolean[] = [];

    mounted = await renderComponent(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        sessionTitle="Historical worker"
        open
        onOpenChange={(open) => openChanges.push(open)}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();

    expect(requests).toEqual([{ action: "archive", roots: [{ rootSessionId: SESSION_ID }] }]);
    const dialog = mounted.container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.className).toContain("100dvh");
    expect(dialog.className).toContain("100vw");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(dialog.textContent).toContain("complete descendant tree");
    expect(dialog.textContent).toContain("2 sessions");

    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close archive review"]')!;
    const confirm = dialog.querySelector<HTMLButtonElement>("[data-session-archive-confirm]")!;
    confirm.focus();
    await act(async () => {
      confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(close);
    close.focus();
    await act(async () => {
      close.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(confirm);

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(openChanges).toEqual([false]);
    await mounted.rerender(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        open={false}
        onOpenChange={() => {}}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    expect(document.activeElement).toBe(opener);
  });

  test("retains one idempotency key across an ambiguous apply failure and retry", async () => {
    const applyRequests: SessionArchiveApplyRequest[] = [];
    let attempts = 0;
    const applied: SessionArchiveApplyResponse[] = [];
    const client = fakeClient({
      planSessionArchive: async () => planFixture("archive"),
      applySessionArchive: async (_workspaceId, request) => {
        applyRequests.push(request);
        attempts += 1;
        if (attempts === 1) {
          throw new Error("connection ended after commit boundary");
        }
        return applyFixture("archive", archivedProjection, request.idempotencyKey);
      },
    });
    mounted = await renderComponent(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        open
        onOpenChange={() => {}}
        onApplied={(response) => applied.push(response)}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();
    const confirm = mounted.container.querySelector<HTMLButtonElement>(
      "[data-session-archive-confirm]",
    )!;

    await actRun(() => confirm.click());
    await flush();
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "connection ended after commit boundary",
    );
    await actRun(() => confirm.click());
    await flush();

    expect(applyRequests).toHaveLength(2);
    expect(applyRequests[0]?.idempotencyKey).toBe(applyRequests[1]?.idempotencyKey);
    expect(applyRequests[0]).toMatchObject({
      manifestChecksum: MANIFEST_CHECKSUM,
      rootSessionId: SESSION_ID,
      rootChecksum: ROOT_CHECKSUM,
      manifest: planFixture("archive").manifest,
    });
    expect(applied).toHaveLength(1);
  });

  test("renders typed blockers and cannot apply until a new blocker-free plan exists", async () => {
    let applyCalls = 0;
    const client = fakeClient({
      planSessionArchive: async () => planFixture("archive", { canApply: false }),
      applySessionArchive: async () => {
        applyCalls += 1;
        return applyFixture("archive", archivedProjection);
      },
    });
    mounted = await renderComponent(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        open
        onOpenChange={() => {}}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();

    const dialog = mounted.container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Goal Active");
    expect(dialog.textContent).toContain("Sandbox Lease Exclusive");
    const confirm = dialog.querySelector<HTMLButtonElement>("[data-session-archive-confirm]")!;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(applyCalls).toBe(0);
  });

  test("fails closed on a stale plan for another workspace", async () => {
    const client = fakeClient({
      planSessionArchive: async () =>
        planFixture("archive", { workspaceId: "99999999-9999-4999-8999-999999999999" }),
    });
    mounted = await renderComponent(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        open
        onOpenChange={() => {}}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "workspace does not match",
    );
    expect(
      mounted.container.querySelector<HTMLButtonElement>("[data-session-archive-confirm]")
        ?.disabled,
    ).toBe(true);
  });

  test("fails closed when a rolling-compatible structural client lacks archival methods", async () => {
    const client = {} as SessionClientLike;
    mounted = await renderComponent(
      <SessionArchiveDialog
        action="archive"
        sessionId={SESSION_ID}
        open
        onOpenChange={() => {}}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "does not support session archival",
    );
    expect(
      mounted.container.querySelector<HTMLButtonElement>("[data-session-archive-confirm]")
        ?.disabled,
    ).toBe(true);
  });

  test("unarchive names the exact seal and explicitly does not resume", async () => {
    const planRequests: SessionArchivePlanRequest[] = [];
    const applyRequests: SessionArchiveApplyRequest[] = [];
    const client = fakeClient({
      planSessionArchive: async (_workspaceId, request) => {
        planRequests.push(request);
        return planFixture("unarchive", { targetSealId: SEAL_ID });
      },
      applySessionArchive: async (_workspaceId, request) => {
        applyRequests.push(request);
        // Another overlapping seal still fences this tree after this release.
        return applyFixture("unarchive", archivedProjection, request.idempotencyKey);
      },
    });
    mounted = await renderComponent(
      <SessionArchiveDialog
        action="unarchive"
        targetSealId={SEAL_ID}
        sessionId={SESSION_ID}
        open
        onOpenChange={() => {}}
        client={client}
        workspaceId={WORKSPACE_ID}
      />,
    );
    await flush();
    const dialog = mounted.container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("will not resume work");
    expect(dialog.textContent).toContain("overlapping seal");
    expect(planRequests).toEqual([
      {
        action: "unarchive",
        roots: [{ rootSessionId: SESSION_ID, targetSealId: SEAL_ID }],
      },
    ]);

    await actRun(() =>
      dialog.querySelector<HTMLButtonElement>("[data-session-archive-confirm]")!.click(),
    );
    await flush();
    expect(applyRequests).toHaveLength(1);
    expect(applyRequests[0]?.manifest?.roots[0]?.targetSealId).toBe(SEAL_ID);
  });
});

describe("SessionArchiveBanner", () => {
  test("is absent for live sessions and names archival/no-resume truth for archived lookup", async () => {
    mounted = await renderComponent(<SessionArchiveBanner archive={liveProjection} />);
    expect(mounted.container.childElementCount).toBe(0);

    let reviews = 0;
    await mounted.rerender(
      <SessionArchiveBanner
        archive={archivedProjection}
        onReviewUnarchive={() => {
          reviews += 1;
        }}
      />,
    );
    const banner = mounted.container.querySelector<HTMLElement>('[aria-label="Archived session"]')!;
    expect(banner.textContent).toContain("execution is fenced");
    expect(banner.textContent).toContain("Unarchive does not resume");
    expect(banner.textContent).toContain(OTHER_SEAL_ID);
    await actRun(() => banner.querySelector<HTMLButtonElement>("button")!.click());
    expect(reviews).toBe(1);
  });
});
