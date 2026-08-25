import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import * as sessionChannelMove from "./session-channel-move";
import {
  applySessionChannelProjection,
  applySessionPinProjection,
  applySessionRailProjection,
  mergeSessionContextProjection,
  notifySessionPinChanged,
  reconcileFailedSessionPin,
  SessionChannelProjectionAuthority,
  subscribeToSessionPinChanges,
} from "./session-pins";

const {
  applySessionChannelMove,
  beginSessionChannelMove,
  commitSessionChannelMove,
  reconcileSessionChannelMovePointRead,
} = sessionChannelMove;

const session = {
  id: "00000000-0000-4000-8000-000000000026",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  status: "running",
  initialMessage: "Keep this lifecycle projection",
  pinned: false,
  pinnedAt: null,
  pinVersion: 0,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:01:00.000Z",
} as Session;

type PortableMoveRequest = Readonly<{
  workspaceId: string;
  sessionId: string;
  operation: number;
  readGeneration: number;
}>;
type PortableMoveResponseDisposition = "accepted" | "verification-required" | "rejected";

function normalizeMoveResponseDisposition(value: unknown): PortableMoveResponseDisposition {
  if (value === true || value === "accepted") return "accepted";
  if (value === "verification-required") return "verification-required";
  return "rejected";
}

function portableMoveAuthority(authority: SessionChannelProjectionAuthority) {
  const persistent = authority as unknown as {
    beginMoveRequest?: (
      owner: object,
      projection: Pick<Session, "id" | "workspaceId">,
    ) => PortableMoveRequest | null;
    ownsMoveRequest?: (owner: object, request: PortableMoveRequest) => boolean;
    recordMoveResponse?: (
      owner: object,
      request: PortableMoveRequest,
      response: Pick<Session, "id" | "workspaceId" | "channelId">,
    ) => unknown;
    finishMoveRequest?: (owner: object, request: PortableMoveRequest) => void;
  };
  const localPending = new WeakMap<object, Map<string, PortableMoveRequest>>();
  const localOperations = new WeakMap<object, number>();
  const moveKey = (request: Pick<PortableMoveRequest, "workspaceId" | "sessionId">) =>
    `${request.workspaceId}\u0000${request.sessionId}`;
  const beginMoveRequest =
    persistent.beginMoveRequest?.bind(authority) ??
    ((owner: object, projection: Pick<Session, "id" | "workspaceId">) => {
      const pending = localPending.get(owner) ?? new Map<string, PortableMoveRequest>();
      localPending.set(owner, pending);
      const key = moveKey({ workspaceId: projection.workspaceId, sessionId: projection.id });
      if (pending.has(key)) return null;
      const request = {
        workspaceId: projection.workspaceId,
        sessionId: projection.id,
        operation: (localOperations.get(owner) ?? 0) + 1,
        readGeneration: authority.beginRead(),
      };
      localOperations.set(owner, request.operation);
      pending.set(key, request);
      return request;
    });
  const ownsMoveRequest =
    persistent.ownsMoveRequest?.bind(authority) ??
    ((owner: object, request: PortableMoveRequest) =>
      localPending.get(owner)?.get(moveKey(request))?.operation === request.operation);
  const persistentRecordMoveResponse = persistent.recordMoveResponse?.bind(authority);
  const recordMoveResponse = (
    owner: object,
    request: PortableMoveRequest,
    response: Session,
  ): PortableMoveResponseDisposition =>
    normalizeMoveResponseDisposition(
      persistentRecordMoveResponse
        ? persistentRecordMoveResponse(owner, request, response)
        : ownsMoveRequest(owner, request) && authority.recordRead(response, authority.beginRead()),
    );
  const finishMoveRequest =
    persistent.finishMoveRequest?.bind(authority) ??
    ((owner: object, request: PortableMoveRequest) => {
      if (ownsMoveRequest(owner, request)) localPending.get(owner)?.delete(moveKey(request));
    });
  return { beginMoveRequest, finishMoveRequest, ownsMoveRequest, recordMoveResponse };
}

describe("session pin reconciliation", () => {
  test("merges the list-owned channel without replacing route lifecycle fields", () => {
    const updated = applySessionChannelProjection(session, {
      id: session.id,
      workspaceId: session.workspaceId,
      channelId: "channel-new",
    });

    expect(updated).toMatchObject({
      status: "running",
      initialMessage: "Keep this lifecycle projection",
      channelId: "channel-new",
    });
    expect(
      applySessionChannelProjection(updated, {
        id: session.id,
        workspaceId: session.workspaceId,
        channelId: "channel-new",
      }),
    ).toBe(updated);
  });

  test("prefers a newer root read over a late older pins-only owner", () => {
    const authority = new SessionChannelProjectionAuthority();
    const rootOwner = {};
    const pinsOwner = {};
    const rootProjection = { ...session, channelId: "channel-new" } as Session;
    const stalePinsProjection = { ...session, channelId: "channel-old" } as Session;

    authority.replace(rootOwner, [rootProjection], 0, 2);
    authority.replace(pinsOwner, [stalePinsProjection], 0, 1);

    expect(authority.owns(rootProjection)).toBe(true);
    expect(authority.owns(stalePinsProjection)).toBe(false);

    authority.replace(pinsOwner, [stalePinsProjection], 0, 3);
    expect(authority.owns(stalePinsProjection)).toBe(true);
  });

  test("rejects stale point reads and 404s before they mutate move or context state", () => {
    const authority = new SessionChannelProjectionAuthority();
    const rootOwner = {};
    const stalePoint = { ...session, channelId: "channel-g" } as Session;
    const newer = { ...session, channelId: "channel-c", status: "running" } as Session;
    const stalePointGeneration = authority.beginRead();
    const newerGeneration = authority.beginRead();
    authority.replace(rootOwner, [newer], 0, newerGeneration);

    let overrides = beginSessionChannelMove(new Map(), session.id, "channel-b", 1);
    overrides = commitSessionChannelMove(overrides, session.id, "channel-b", 1);
    overrides = reconcileSessionChannelMovePointRead(overrides, session.id, 1, newer);
    let current = newer;

    const acceptedStalePoint = authority.recordRead(stalePoint, stalePointGeneration);
    if (acceptedStalePoint) {
      overrides = reconcileSessionChannelMovePointRead(overrides, session.id, 1, stalePoint);
      current = applySessionChannelProjection(current, stalePoint)!;
    }
    expect(acceptedStalePoint).toBe(false);
    expect(overrides.size).toBe(0);
    expect(current).toBe(newer);

    const acceptedStaleMissing = authority.recordMissing(
      { id: session.id, workspaceId: session.workspaceId },
      stalePointGeneration,
    );
    if (acceptedStaleMissing) {
      overrides = reconcileSessionChannelMovePointRead(overrides, session.id, 1, null);
    }
    expect(acceptedStaleMissing).toBe(false);
    expect(overrides.size).toBe(0);
    expect(current).toBe(newer);
  });

  test("retains exact move evidence after the component move owner unmounts", () => {
    const authority = new SessionChannelProjectionAuthority();
    const moveOwner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const moved = { ...session, channelId: "channel-b" } as Session;
    const staleDetailGeneration = authority.beginRead();

    authority.replace(moveOwner, [moved], 1);
    const moveEvidenceGeneration = authority.beginRead();
    expect(authority.recordRead(moved, moveEvidenceGeneration)).toBe(true);

    // Collapsing the desktop rail or selecting the mobile Workspace tab used
    // to unmount SessionList and clear this component-owned priority fence.
    authority.clear(moveOwner);
    expect(authority.recordRead(beforeMove, staleDetailGeneration)).toBe(false);
    expect(mergeSessionContextProjection(moved, beforeMove, authority, "detail")).toMatchObject({
      channelId: "channel-b",
    });

    // A failed queued probe contributes no evidence; the exact successful
    // write response must remain sufficient to hold the committed destination.
    expect(authority.owns(moved)).toBe(true);
    expect(authority.owns(beforeMove)).toBe(false);
  });

  test("reconciles a committed move when a newer accepted detail wins before its probe", () => {
    const authority = new SessionChannelProjectionAuthority();
    const moveOwner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const moved = { ...session, channelId: "channel-b" } as Session;
    const movedAgain = { ...session, channelId: "channel-c" } as Session;
    let overrides = beginSessionChannelMove(new Map(), session.id, moved.channelId ?? null, 1);
    let current = beforeMove;

    const subscribeToAcceptedReads = (
      authority as SessionChannelProjectionAuthority & {
        subscribeToAcceptedReads?: (
          listener: (accepted?: Pick<Session, "id" | "workspaceId" | "channelId">) => void,
        ) => () => void;
      }
    ).subscribeToAcceptedReads?.bind(authority);
    const unsubscribe =
      subscribeToAcceptedReads?.((accepted) => {
        if (!accepted) return;
        const override = overrides.get(accepted.id);
        if (override?.committed) {
          overrides = reconcileSessionChannelMovePointRead(
            overrides,
            accepted.id,
            override.operation,
            accepted,
          );
        }
        current = applySessionChannelProjection(current, accepted)!;
      }) ?? (() => {});

    const moveEvidenceGeneration = authority.beginRead();
    expect(authority.recordRead(moved, moveEvidenceGeneration)).toBe(true);
    overrides = commitSessionChannelMove(overrides, session.id, moved.channelId ?? null, 1);
    current = moved;
    authority.replace(moveOwner, [moved], 1);
    const staleProbeGeneration = authority.beginRead();
    const newerDetailGeneration = authority.beginRead();

    expect(authority.recordRead(movedAgain, newerDetailGeneration)).toBe(true);
    current = mergeSessionContextProjection(current, movedAgain, authority, "detail")!;
    authority.clear(moveOwner);
    expect(overrides.size).toBe(0);
    expect(current.channelId).toBe("channel-c");

    // A probe started before the newer detail is stale if it returns B, and a
    // failed probe contributes no observation at all. Neither path can put B
    // back after the accepted detail has reconciled the committed override.
    expect(authority.recordRead(moved, staleProbeGeneration)).toBe(false);
    expect(overrides.size).toBe(0);
    expect(current.channelId).toBe("channel-c");
    unsubscribe();
  });

  test("keeps exact pending move ownership across a rail unmount and remount", () => {
    const authority = new SessionChannelProjectionAuthority();
    const firstRailOwner = {};
    const remountedRailOwner = {};
    const beforeMove = { ...session, channelId: "channel-original" } as Session;
    const firstResponse = { ...session, channelId: "channel-a" } as Session;
    const newerResponse = { ...session, channelId: "channel-b" } as Session;
    let current = beforeMove;
    let acceptedResponses = 0;

    const { beginMoveRequest, finishMoveRequest, ownsMoveRequest, recordMoveResponse } =
      portableMoveAuthority(authority);

    const firstRequest = beginMoveRequest(firstRailOwner, beforeMove)!;
    // The mounted rail cannot issue a duplicate request for the same session.
    expect(beginMoveRequest(firstRailOwner, beforeMove)).toBeNull();

    // Unmounting does not make the first response ownerless. A newly mounted
    // rail may express a newer intent, which supersedes the retained request.
    const newerRequest = beginMoveRequest(remountedRailOwner, beforeMove)!;
    expect(ownsMoveRequest(remountedRailOwner, newerRequest)).toBe(true);

    const settle = (owner: object, request: typeof firstRequest, response: Session): boolean => {
      if (recordMoveResponse(owner, request, response) !== "accepted") return false;
      acceptedResponses += 1;
      current = applySessionChannelProjection(current, response)!;
      finishMoveRequest(owner, request);
      return true;
    };

    expect(settle(remountedRailOwner, newerRequest, newerResponse)).toBe(true);
    expect(settle(firstRailOwner, firstRequest, firstResponse)).toBe(false);
    finishMoveRequest(firstRailOwner, firstRequest);

    expect(acceptedResponses).toBe(1);
    expect(current.channelId).toBe("channel-b");
    expect(authority.owns(newerResponse)).toBe(true);
    expect(authority.owns(firstResponse)).toBe(false);
  });

  test("retains a successful raw move response after the rail owner unmounts", () => {
    const authority = new SessionChannelProjectionAuthority();
    const firstRailOwner = {};
    const remountedListOwner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const moved = { ...session, channelId: "channel-b" } as Session;
    const staleRemountedReadGeneration = authority.beginRead();
    const request = authority.beginMoveRequest(firstRailOwner, beforeMove)!;
    const recordMoveResponse = (
      authority as unknown as {
        recordMoveResponse?: (
          owner: object,
          request: PortableMoveRequest,
          response: Session,
        ) => unknown;
      }
    ).recordMoveResponse?.bind(authority);

    // The component owner has unmounted, but no newer intent superseded its
    // persistent token. The raw client result must still become exact evidence.
    expect(
      normalizeMoveResponseDisposition(recordMoveResponse?.(firstRailOwner, request, moved)),
    ).toBe("accepted");
    authority.replace(remountedListOwner, [beforeMove], 0, staleRemountedReadGeneration);
    expect(authority.project(beforeMove, staleRemountedReadGeneration)).toMatchObject({
      channelId: "channel-b",
    });
    expect(authority.owns(moved)).toBe(true);
  });

  test("requires a post-settlement read when newer evidence overlaps a move response", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const delayedMove = { ...session, channelId: "channel-b" } as Session;
    const newerRead = { ...session, channelId: "channel-c" } as Session;
    const { beginMoveRequest, recordMoveResponse } = portableMoveAuthority(authority);

    const request = beginMoveRequest(owner, beforeMove)!;
    expect(authority.recordRead(newerRead, authority.beginRead())).toBe(true);

    // The response cannot distinguish a read that observed a later C from one
    // that merely returned pre-commit A. Preserve start ordering, then require
    // an exact request that starts after the response settles.
    expect(recordMoveResponse(owner, request, delayedMove)).toBe("verification-required");
    expect(authority.recordRead(newerRead, authority.beginRead())).toBe(true);
    expect(authority.owns(newerRead)).toBe(true);
    expect(authority.owns(delayedMove)).toBe(false);
  });

  test("keeps a successful move through an overlapping stale read until verification", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const moved = { ...session, channelId: "channel-b" } as Session;
    const { beginMoveRequest, recordMoveResponse } = portableMoveAuthority(authority);
    const request = beginMoveRequest(owner, beforeMove)!;
    const overlappingReadGeneration = authority.beginRead();

    // This GET starts after the PUT, but returns the pre-commit A before the
    // successful PUT response B settles.
    expect(authority.recordRead(beforeMove, overlappingReadGeneration)).toBe(true);
    expect(recordMoveResponse(owner, request, moved)).toBe("verification-required");

    let overrides = beginSessionChannelMove(
      new Map(),
      session.id,
      moved.channelId ?? null,
      request.operation,
    );
    overrides = commitSessionChannelMove(
      overrides,
      session.id,
      moved.channelId ?? null,
      request.operation,
    );
    expect(applySessionChannelMove(beforeMove, overrides.get(session.id)).channelId).toBe(
      "channel-b",
    );

    const verificationGeneration = authority.beginRead();
    expect(authority.recordRead(moved, verificationGeneration)).toBe(true);
    overrides = reconcileSessionChannelMovePointRead(
      overrides,
      session.id,
      request.operation,
      moved,
    );
    expect(overrides.size).toBe(0);
    expect(authority.project(beforeMove, overlappingReadGeneration).channelId).toBe("channel-b");
  });

  test("fences an overlapping stale read that settles after a successful move response", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const moved = { ...session, channelId: "channel-b" } as Session;
    const { beginMoveRequest, recordMoveResponse } = portableMoveAuthority(authority);
    const request = beginMoveRequest(owner, beforeMove)!;

    // This GET snapshots pre-commit A while the PUT is pending, but does not
    // settle until after the successful PUT response B has been accepted.
    const overlappingReadGeneration = authority.beginRead();
    expect(recordMoveResponse(owner, request, moved)).toBe("accepted");
    expect(authority.recordRead(beforeMove, overlappingReadGeneration)).toBe(false);
    expect(authority.project(beforeMove, overlappingReadGeneration).channelId).toBe("channel-b");
    expect(authority.owns(moved)).toBe(true);
    expect(authority.owns(beforeMove)).toBe(false);
  });

  test("uses post-settlement authority before retiring an ambiguous move overlay", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
    const beforeMove = { ...session, channelId: "channel-a" } as Session;
    const delayedMove = { ...session, channelId: "channel-b" } as Session;
    const newerRead = { ...session, channelId: "channel-c" } as Session;
    const { beginMoveRequest, recordMoveResponse } = portableMoveAuthority(authority);
    const request = beginMoveRequest(owner, beforeMove)!;
    let overrides = beginSessionChannelMove(
      new Map(),
      session.id,
      delayedMove.channelId ?? null,
      request.operation,
    );

    expect(authority.recordRead(newerRead, authority.beginRead())).toBe(true);
    expect(recordMoveResponse(owner, request, delayedMove)).toBe("verification-required");
    overrides = commitSessionChannelMove(
      overrides,
      session.id,
      delayedMove.channelId ?? null,
      request.operation,
    );
    expect(authority.recordRead(newerRead, authority.beginRead())).toBe(true);
    overrides = reconcileSessionChannelMovePointRead(
      overrides,
      session.id,
      request.operation,
      newerRead,
    );

    expect(overrides.has(session.id)).toBe(false);
    expect(applySessionChannelMove(newerRead, overrides.get(session.id)).channelId).toBe(
      "channel-c",
    );
  });

  test("transfers a compacted accepted fence before an ephemeral owner clears", () => {
    const authority = new SessionChannelProjectionAuthority();
    const rootOwner = {};
    const stale = { ...session, channelId: "channel-a" } as Session;
    const accepted = { ...session, channelId: "channel-b" } as Session;
    const staleGeneration = authority.beginRead();
    expect(authority.recordRead(accepted, authority.beginRead())).toBe(true);
    authority.replace(rootOwner, [accepted], 0, authority.beginRead());

    for (let index = 0; index < 512; index += 1) {
      expect(
        authority.recordRead(
          {
            id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            workspaceId: session.workspaceId,
            channelId: null,
          },
          authority.beginRead(),
        ),
      ).toBe(true);
    }

    // Compaction may discard the older accepted entry while root B replaces
    // it, but clearing that component owner must retain B before dropping it.
    authority.clear(rootOwner);
    expect(authority.recordRead(stale, staleGeneration)).toBe(false);
    expect(authority.project(stale, staleGeneration)).toMatchObject({ channelId: "channel-b" });
    expect(authority.owns(accepted)).toBe(true);
  });

  test("publishes an accepted-read revision for a remounted non-open row", () => {
    const authority = new SessionChannelProjectionAuthority();
    const staleRow = { ...session, channelId: "channel-a" } as Session;
    const acceptedProbe = { ...session, channelId: "channel-b" } as Session;
    const staleReadGeneration = authority.beginRead();
    let rendered = authority.project(staleRow, staleReadGeneration);
    const reactive = authority as unknown as {
      getAcceptedReadRevision?: () => number;
      subscribeToAcceptedReads: (listener: () => void) => () => void;
    };
    let observedRevision = reactive.getAcceptedReadRevision?.() ?? 0;
    const unsubscribe = reactive.subscribeToAcceptedReads(() => {
      observedRevision = reactive.getAcceptedReadRevision?.() ?? observedRevision;
      rendered = authority.project(staleRow, staleReadGeneration);
    });

    expect(authority.recordRead(acceptedProbe, authority.beginRead())).toBe(true);
    expect(observedRevision).toBeGreaterThan(0);
    expect(rendered.channelId).toBe("channel-b");
    unsubscribe();
  });

  test("does not evict an accepted winner while an older branch owner can revive", () => {
    const authority = new SessionChannelProjectionAuthority();
    const branchOwner = {};
    const staleBranch = { ...session, channelId: "channel-a" } as Session;
    const acceptedDetail = { ...session, channelId: "channel-b" } as Session;
    const branchGeneration = authority.beginRead();
    authority.replace(branchOwner, [staleBranch], 0, branchGeneration);
    const detailGeneration = authority.beginRead();
    expect(authority.recordRead(acceptedDetail, detailGeneration)).toBe(true);

    for (let index = 0; index < 512; index += 1) {
      const projection = {
        id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        workspaceId: session.workspaceId,
        channelId: `channel-${index}`,
      };
      expect(authority.recordRead(projection, authority.beginRead())).toBe(true);
    }

    expect(authority.project(staleBranch, branchGeneration)).toMatchObject({
      channelId: "channel-b",
    });
    expect(authority.owns(acceptedDetail)).toBe(true);
    expect(authority.owns(staleBranch)).toBe(false);
  });

  test("compacts superseded reads without losing owner evidence and clears departed workspaces", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
    const accepted = { ...session, channelId: "channel-b" } as Session;
    const acceptedGeneration = authority.beginRead();
    authority.recordRead(accepted, acceptedGeneration);
    authority.replace(owner, [accepted], 0, authority.beginRead());

    for (let index = 0; index < 512; index += 1) {
      authority.recordRead(
        {
          id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          workspaceId: session.workspaceId,
          channelId: null,
        },
        authority.beginRead(),
      );
    }

    authority.clear(owner);
    expect(authority.project({ ...session, channelId: "channel-a" }, 0)).toMatchObject({
      channelId: "channel-b",
    });

    authority.recordRead(accepted, authority.beginRead());
    expect(authority.owns(accepted)).toBe(true);
    const otherWorkspace = { ...accepted, workspaceId: "workspace-other" };
    authority.recordRead(otherWorkspace, authority.beginRead());
    const moveOwner = {};
    const departedMove = authority.beginMoveRequest(moveOwner, accepted)!;
    const retainedMove = authority.beginMoveRequest(moveOwner, otherWorkspace)!;
    authority.clearWorkspace(session.workspaceId);
    expect(authority.owns(accepted)).toBe(false);
    expect(authority.owns(otherWorkspace)).toBe(true);
    expect(authority.ownsMoveRequest(moveOwner, departedMove)).toBe(false);
    expect(authority.ownsMoveRequest(moveOwner, retainedMove)).toBe(true);
  });

  test("merges only authoritative personal pin fields", () => {
    const updated = applySessionPinProjection(session, {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: "2026-07-10T00:02:00.000Z",
      pinVersion: 3,
    });

    expect(updated).not.toBe(session);
    expect(updated).toMatchObject({
      status: "running",
      initialMessage: "Keep this lifecycle projection",
      pinned: true,
      pinnedAt: "2026-07-10T00:02:00.000Z",
      pinVersion: 3,
    });
  });

  test("ignores another session or workspace and preserves referential stability", () => {
    expect(
      applySessionPinProjection(session, {
        id: "00000000-0000-4000-8000-000000000099",
        workspaceId: session.workspaceId,
        pinned: true,
        pinnedAt: "2026-07-10T00:02:00.000Z",
        pinVersion: 1,
      }),
    ).toBe(session);
    expect(
      applySessionPinProjection(session, {
        id: session.id,
        workspaceId: "00000000-0000-4000-8000-000000000002",
        pinned: true,
        pinnedAt: "2026-07-10T00:02:00.000Z",
        pinVersion: 1,
      }),
    ).toBe(session);
    expect(
      applySessionPinProjection(session, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: false,
        pinnedAt: null,
        pinVersion: 0,
      }),
    ).toBe(session);
  });

  test("never lets a stale list or mutation response regress a newer pin revision", () => {
    const current = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:03:00.000Z",
      pinVersion: 4,
    };

    expect(
      applySessionPinProjection(current, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: false,
        pinnedAt: null,
        pinVersion: 3,
      }),
    ).toBe(current);

    // Equal revisions are allowed to replace an optimistic timestamp with the
    // canonical timestamp returned by the server.
    expect(
      applySessionPinProjection(current, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: true,
        pinnedAt: "2026-07-10T00:02:59.000Z",
        pinVersion: 4,
      }),
    ).toMatchObject({
      pinned: true,
      pinnedAt: "2026-07-10T00:02:59.000Z",
      pinVersion: 4,
    });
  });

  test("a failed first pin may reconcile the exact optimistic version back to absent", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:04:00.000Z",
      pinVersion: 1,
    };
    expect(reconcileFailedSessionPin(optimistic, optimistic, session)).toEqual(session);
  });

  test("failure reconciliation cannot regress an intervening newer projection", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:04:00.000Z",
      pinVersion: 1,
    };
    const newer = {
      ...optimistic,
      pinned: false,
      pinnedAt: null,
      pinVersion: 2,
    };
    expect(reconcileFailedSessionPin(newer, optimistic, session)).toBe(newer);
  });

  test("keeps route lifecycle while copying list pin and hierarchy projections", () => {
    const projected = {
      ...session,
      status: "idle",
      initialMessage: "Stale list content",
      pinned: true,
      pinnedAt: "2026-07-10T00:05:00.000Z",
      pinVersion: 5,
      channelId: "channel-new",
      treeStats: {
        directChildren: 2,
        totalDescendants: 4,
        runningDescendants: 1,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
      },
    } as Session;

    expect(applySessionRailProjection(session, projected)).toMatchObject({
      status: "running",
      initialMessage: "Keep this lifecycle projection",
      pinned: true,
      pinnedAt: "2026-07-10T00:05:00.000Z",
      pinVersion: 5,
      channelId: "channel-new",
      treeStats: projected.treeStats,
    });
  });

  test("retains display-only list fields without copying an expired channel projection", () => {
    const current = { ...session, channelId: "channel-new" } as Session;
    const retained = {
      ...session,
      channelId: "channel-old",
      pinned: true,
      pinnedAt: "2026-07-10T00:05:00.000Z",
      pinVersion: 5,
      treeStats: {
        directChildren: 1,
        totalDescendants: 1,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
      },
    } as Session;

    expect(applySessionRailProjection(current, retained, { channelOwned: false })).toMatchObject({
      channelId: "channel-new",
      pinned: true,
      pinVersion: 5,
      treeStats: retained.treeStats,
    });
  });

  test("preserves rail identity when a fresh equal tree summary is returned", () => {
    const treeStats = {
      directChildren: 2,
      totalDescendants: 4,
      runningDescendants: 1,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    };
    const current = { ...session, treeStats } as Session;
    const refreshed = { ...current, treeStats: { ...treeStats } };

    expect(applySessionRailProjection(current, refreshed)).toBe(current);
  });

  test("keeps a newer context pin while adopting detail content", () => {
    const current = {
      ...session,
      title: "Renamed in the open route",
      pinned: true,
      pinnedAt: "2026-07-10T00:06:00.000Z",
      pinVersion: 2,
    } as Session;
    const staleDetail = {
      ...session,
      title: "Stale detail title",
      status: "failed",
      pinned: false,
      pinnedAt: null,
      pinVersion: 1,
    } as Session;

    const merged = mergeSessionContextProjection(
      current,
      staleDetail,
      new SessionChannelProjectionAuthority(),
      "detail",
    );

    expect(merged).toMatchObject({
      title: "Stale detail title",
      status: "failed",
      pinned: true,
      pinnedAt: "2026-07-10T00:06:00.000Z",
      pinVersion: 2,
    });
    expect(merged).not.toBe(staleDetail);
  });

  test("preserves identity when the detail and context pin triples are equal", () => {
    const current = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:07:00.000Z",
      pinVersion: 3,
    } as Session;
    const detail = {
      ...current,
      effectiveControl: { ...current.effectiveControl },
    };

    const merged = mergeSessionContextProjection(
      current,
      detail,
      new SessionChannelProjectionAuthority(),
      "detail",
    );

    expect(merged).toBe(detail);
  });

  test("carries a title_set detail update through a rail pin projection", () => {
    const titleSetDetail = {
      ...session,
      title: "Title from session.title_set",
      effectiveControl: { ...session.effectiveControl },
    } as Session;
    const afterTitle = mergeSessionContextProjection(
      null,
      titleSetDetail,
      new SessionChannelProjectionAuthority(),
      "detail",
    );
    const afterPin = applySessionPinProjection(afterTitle, {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: "2026-07-10T00:08:00.000Z",
      pinVersion: 1,
    });

    expect(afterPin).toMatchObject({
      title: "Title from session.title_set",
      pinned: true,
      pinnedAt: "2026-07-10T00:08:00.000Z",
      pinVersion: 1,
    });
  });

  test("preserves identity when failed reconciliation already matches authoritative state", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:09:00.000Z",
      pinVersion: 1,
    } as Session;
    const authoritative = {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: optimistic.pinnedAt,
      pinVersion: 1,
    };

    expect(reconcileFailedSessionPin(optimistic, optimistic, authoritative)).toBe(optimistic);
  });

  test("deduplicates BroadcastChannel delivery for one cross-tab mutation", () => {
    type Listener = (event: { data: unknown }) => void;
    class FakeBroadcastChannel {
      static readonly instances: FakeBroadcastChannel[] = [];
      readonly name: string;
      readonly listeners = new Set<Listener>();

      constructor(name: string) {
        this.name = name;
        FakeBroadcastChannel.instances.push(this);
      }

      addEventListener(_type: "message", listener: Listener): void {
        this.listeners.add(listener);
      }

      postMessage(data: unknown): void {
        for (const instance of FakeBroadcastChannel.instances) {
          if (instance === this || instance.name !== this.name) continue;
          for (const listener of instance.listeners) {
            listener({ data });
            listener({ data });
          }
        }
      }

      close(): void {
        this.listeners.clear();
      }
    }

    const original = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
      writable: true,
    });
    try {
      const changes: string[] = [];
      const cleanup = subscribeToSessionPinChanges("workspace-1", (sessionId) => {
        changes.push(sessionId);
      });

      notifySessionPinChanged("workspace-1", session.id);

      expect(changes).toEqual([session.id]);
      cleanup();
    } finally {
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });
});
