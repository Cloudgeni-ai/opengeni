import { describe, expect, test } from "bun:test";
import {
  canonicalizeSessionArchiveManifest,
  SessionArchiveApplyRequest,
  SessionArchiveDenial,
  SessionArchivePlanRequest,
  SessionArchiveProjection,
  stringifySessionArchiveManifest,
} from "../../contracts/src/session-archive";
import {
  assertSessionArchiveManifestChecksum,
  sessionArchiveCoverageChecksum,
  sessionArchiveManifestChecksum,
  sessionArchivePreconditionChecksum,
  sessionArchiveRequestHash,
  sessionArchiveRootChecksum,
} from "../src/session-archive-manifest";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const rootA = "00000000-0000-4000-8000-000000000010";
const childA = "00000000-0000-4000-8000-000000000011";
const rootB = "00000000-0000-4000-8000-000000000020";

function manifest() {
  return {
    format: "opengeni.session-archive-manifest",
    version: 1,
    workspaceId: workspaceId.toUpperCase(),
    action: "archive",
    totalMemberCount: 3,
    roots: [
      {
        rootSessionId: rootB.toUpperCase(),
        targetSealId: null,
        memberCount: 1,
        members: [
          {
            sessionId: rootB.toUpperCase(),
            parentSessionId: null,
            depth: 0,
            expectedArchiveRevision: "9",
            expectedArchived: false,
          },
        ],
      },
      {
        rootSessionId: rootA,
        targetSealId: null,
        memberCount: 2,
        members: [
          {
            sessionId: childA,
            parentSessionId: rootA,
            depth: 1,
            expectedArchiveRevision: "12",
            expectedArchived: true,
          },
          {
            sessionId: rootA,
            parentSessionId: null,
            depth: 0,
            expectedArchiveRevision: "0",
            expectedArchived: false,
          },
        ],
      },
    ],
  };
}

describe("session archive manifest", () => {
  test("canonicalizes UUID case and deterministic root/member order", () => {
    const canonical = canonicalizeSessionArchiveManifest(manifest());
    expect(canonical.workspaceId).toBe(workspaceId);
    expect(canonical.roots.map((root) => root.rootSessionId)).toEqual([rootA, rootB]);
    expect(canonical.roots[0]?.members.map((member) => member.sessionId)).toEqual([rootA, childA]);
    expect(stringifySessionArchiveManifest(manifest())).toBe(
      `{"format":"opengeni.session-archive-manifest","version":1,"workspaceId":"${workspaceId}","action":"archive","totalMemberCount":3,"roots":[{"rootSessionId":"${rootA}","targetSealId":null,"memberCount":2,"members":[{"sessionId":"${rootA}","parentSessionId":null,"depth":0,"expectedArchiveRevision":"0","expectedArchived":false},{"sessionId":"${childA}","parentSessionId":"${rootA}","depth":1,"expectedArchiveRevision":"12","expectedArchived":true}]},{"rootSessionId":"${rootB}","targetSealId":null,"memberCount":1,"members":[{"sessionId":"${rootB}","parentSessionId":null,"depth":0,"expectedArchiveRevision":"9","expectedArchived":false}]}]}`,
    );
  });

  test("has stable bulk and per-root SHA-256 checksums", () => {
    expect(sessionArchiveManifestChecksum(manifest())).toBe(
      "sha256:df02bc6ccc6982d5cbcb6d9f209b7a96c5436560a4ebab201cb30014a09ce049",
    );
    expect(sessionArchiveRootChecksum(manifest(), rootA)).toBe(
      "sha256:0f315aa6a43ca058def18727afd6fc7f87837700d3c6dc46028aa5167f5ca6d9",
    );
  });

  test("accepts the exact checksum and rejects malformed or mismatched checksums", () => {
    const checksum = sessionArchiveManifestChecksum(manifest());
    expect(assertSessionArchiveManifestChecksum(manifest(), checksum)).toBe(checksum);
    expect(() => assertSessionArchiveManifestChecksum(manifest(), checksum.toUpperCase())).toThrow(
      "sha256:<64 lower-case hex>",
    );
    expect(() =>
      assertSessionArchiveManifestChecksum(
        manifest(),
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).toThrow("checksum mismatch");
  });

  test("rejects duplicate or structurally incomplete root coverage", () => {
    expect(() =>
      SessionArchivePlanRequest.parse({
        action: "archive",
        roots: [{ rootSessionId: rootA }, { rootSessionId: rootA.toUpperCase() }],
      }),
    ).toThrow(`duplicate root ${rootA}`);

    const duplicate = structuredClone(manifest());
    duplicate.roots[1]!.members[0]!.sessionId = rootB;
    expect(() => canonicalizeSessionArchiveManifest(duplicate)).toThrow(
      `session ${rootB} appears in more than one root`,
    );

    const missingParent = structuredClone(manifest());
    missingParent.roots[1]!.members[0]!.parentSessionId = rootB;
    expect(() => canonicalizeSessionArchiveManifest(missingParent)).toThrow(
      `parent ${rootB} outside root ${rootA}`,
    );

    const parentedRoot = structuredClone(manifest());
    parentedRoot.roots[1]!.members[1]!.parentSessionId = childA;
    expect(() => canonicalizeSessionArchiveManifest(parentedRoot)).toThrow(
      `root ${rootA} must be present at depth 0 with no parent`,
    );
  });

  test("rejects count mismatches, invalid revisions, and action/seal mismatches", () => {
    const badCount = structuredClone(manifest());
    badCount.totalMemberCount = 4;
    expect(() => canonicalizeSessionArchiveManifest(badCount)).toThrow(
      "totalMemberCount 4 does not match 3 members",
    );

    const badRevision = structuredClone(manifest());
    badRevision.roots[0]!.members[0]!.expectedArchiveRevision = "01";
    expect(() => canonicalizeSessionArchiveManifest(badRevision)).toThrow(
      "unsigned canonical decimal string",
    );

    const badSeal = structuredClone(manifest());
    badSeal.roots[0]!.targetSealId = "00000000-0000-4000-8000-000000000099";
    expect(() => canonicalizeSessionArchiveManifest(badSeal)).toThrow(
      `archive root ${rootB} must not name a target seal`,
    );
  });

  test("pins typed plan/apply, projection, and fail-closed denial wire shapes", () => {
    expect(
      SessionArchivePlanRequest.parse({
        action: "archive",
        roots: [{ rootSessionId: rootA }],
      }),
    ).toEqual({ action: "archive", roots: [{ rootSessionId: rootA, targetSealId: null }] });
    expect(() =>
      SessionArchivePlanRequest.parse({
        action: "unarchive",
        roots: [{ rootSessionId: rootA }],
      }),
    ).toThrow("must name their target seal");

    const checksum = sessionArchiveManifestChecksum(manifest());
    expect(
      SessionArchiveApplyRequest.parse({
        manifest: manifest(),
        manifestChecksum: checksum,
        rootSessionId: rootA,
        rootChecksum: sessionArchiveRootChecksum(manifest(), rootA),
        idempotencyKey: "bulk:root-a",
      }).rootSessionId,
    ).toBe(rootA);
    expect(
      SessionArchiveApplyRequest.parse({
        manifest: null,
        manifestChecksum: checksum,
        rootSessionId: rootA,
        rootChecksum: sessionArchiveRootChecksum(manifest(), rootA),
        idempotencyKey: "bulk:root-a",
      }).manifest,
    ).toBeNull();
    expect(() =>
      SessionArchiveApplyRequest.parse({
        manifest: manifest(),
        manifestChecksum: checksum,
        rootSessionId: "00000000-0000-4000-8000-000000000099",
        rootChecksum: sessionArchiveRootChecksum(manifest(), rootA),
        idempotencyKey: "bulk:root-a",
      }),
    ).toThrow("must be present in the supplied bulk manifest");

    expect(
      SessionArchiveProjection.parse({
        archived: false,
        archiveRevision: "0",
        activeSealCount: 0,
        archivedAt: null,
        nearestFence: null,
      }),
    ).toEqual({
      archived: false,
      archiveRevision: "0",
      activeSealCount: 0,
      archivedAt: null,
      nearestFence: null,
    });
    expect(
      SessionArchiveDenial.parse({
        code: "archived_ancestry",
        targetSessionId: childA,
        archivedAncestorSessionId: rootA,
        archiveRootSessionId: rootA,
        archiveSealId: "00000000-0000-4000-8000-000000000099",
        archiveRevision: "13",
        operation: "create_child",
        retryable: false,
      }).retryable,
    ).toBe(false);
  });

  test("binds canonical request, blocker-free precondition, and exact receipt coverage", () => {
    const sealId = "00000000-0000-4000-8000-000000000099";
    const manifestChecksum = sessionArchiveManifestChecksum(manifest());
    const rootChecksum = sessionArchiveRootChecksum(manifest(), rootA);
    const idempotencyKey = `session-archive:${manifestChecksum.slice(7)}:${rootChecksum.slice(7)}`;
    const authority = {
      actorSubjectId: "operator:authenticated-caller",
      grantSubjectId: "operator:archive-grant",
      grantAuthority: "workspace:admin",
    };
    const members = [
      {
        sessionId: childA,
        parentSessionId: rootA,
        depth: 1,
        beforeArchiveRevision: "12",
        afterArchiveRevision: "13",
        beforeArchived: true,
        afterArchived: true,
      },
      {
        sessionId: rootA,
        parentSessionId: null,
        depth: 0,
        beforeArchiveRevision: "0",
        afterArchiveRevision: "1",
        beforeArchived: false,
        afterArchived: true,
      },
    ];
    const requestHash = sessionArchiveRequestHash({
      workspaceId,
      action: "archive",
      manifestChecksum,
      rootSessionId: rootA,
      rootChecksum,
      targetSealId: null,
      idempotencyKey,
    });
    const preconditionChecksum = sessionArchivePreconditionChecksum({
      workspaceId,
      action: "archive",
      manifestChecksum,
      rootSessionId: rootA,
      rootChecksum,
      targetSealId: null,
      blockerCount: 0,
      members,
    });
    const checksum = sessionArchiveCoverageChecksum({
      workspaceId,
      action: "archive",
      manifestChecksum,
      rootSessionId: rootA,
      rootChecksum,
      targetSealId: null,
      resultingSealId: sealId,
      requestHash,
      idempotencyKey,
      authority,
      preconditionChecksum,
      members,
    });
    expect(requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preconditionChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      sessionArchiveRequestHash({
        workspaceId: workspaceId.toUpperCase(),
        action: "archive",
        manifestChecksum,
        rootSessionId: rootA.toUpperCase(),
        rootChecksum,
        targetSealId: null,
        idempotencyKey,
      }),
    ).toBe(requestHash);
    expect(
      sessionArchivePreconditionChecksum({
        workspaceId: workspaceId.toUpperCase(),
        action: "archive",
        manifestChecksum,
        rootSessionId: rootA.toUpperCase(),
        rootChecksum,
        targetSealId: null,
        blockerCount: 0,
        members: members.toReversed(),
      }),
    ).toBe(preconditionChecksum);
    expect(
      sessionArchiveCoverageChecksum({
        workspaceId: workspaceId.toUpperCase(),
        action: "archive",
        manifestChecksum,
        rootSessionId: rootA.toUpperCase(),
        rootChecksum,
        targetSealId: null,
        resultingSealId: sealId.toUpperCase(),
        requestHash,
        idempotencyKey,
        authority,
        preconditionChecksum,
        members: members.toReversed(),
      }),
    ).toBe(checksum);
    expect(() =>
      sessionArchivePreconditionChecksum({
        workspaceId,
        action: "archive",
        manifestChecksum,
        rootSessionId: rootA,
        rootChecksum,
        targetSealId: null,
        blockerCount: 1,
        members,
      }),
    ).toThrow("requires zero blockers");
    expect(() =>
      sessionArchiveCoverageChecksum({
        workspaceId,
        action: "archive",
        manifestChecksum,
        rootSessionId: rootA,
        rootChecksum,
        targetSealId: null,
        resultingSealId: sealId,
        requestHash,
        idempotencyKey,
        authority,
        preconditionChecksum,
        members: [members[0], members[0]],
      }),
    ).toThrow(`Duplicate session archive coverage member ${childA}`);
  });
});
