import { describe, expect, test } from "bun:test";
import type {
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactEvent,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  WorkspaceArtifactVersion,
} from "@opengeni/contracts";

import {
  projectWorkspaceArtifactDetailProvenance,
  projectWorkspaceArtifactMutationProvenance,
  projectWorkspaceArtifactVersionProvenance,
  redactWorkspaceArtifactListProvenance,
} from "../src/workspace-artifact-provenance";

function version(id: string, sourceSessionId: string | null): WorkspaceArtifactVersion {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    artifactId: "00000000-0000-4000-8000-000000000003",
    revision: 1,
    contentType: "text/html",
    contentSha256: "a".repeat(64),
    sizeBytes: 1,
    sourceSha256: null,
    sourceSizeBytes: null,
    requestedTools: [],
    sourceSessionId,
    sourceTurnId: sourceSessionId ? "00000000-0000-4000-8000-000000000005" : null,
    sourceAttemptId: sourceSessionId ? "00000000-0000-4000-8000-000000000006" : null,
    sourceExecutionGeneration: sourceSessionId ? 1 : null,
    createdBySubjectId: "subject-1",
    createdAt: "2026-09-03T00:00:00.000Z",
  };
}

function event(id: string, sourceSessionId: string | null): WorkspaceArtifactEvent {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    artifactId: "00000000-0000-4000-8000-000000000003",
    type: "published",
    fromVersionId: null,
    toVersionId: "00000000-0000-4000-8000-000000000004",
    sourceSessionId,
    sourceTurnId: sourceSessionId ? "00000000-0000-4000-8000-000000000005" : null,
    sourceAttemptId: sourceSessionId ? "00000000-0000-4000-8000-000000000006" : null,
    sourceExecutionGeneration: sourceSessionId ? 1 : null,
    actorSubjectId: "subject-1",
    reason: "Published",
    createdAt: "2026-09-03T00:00:00.000Z",
  };
}

function detail(
  currentVersion: WorkspaceArtifactVersion,
  versions: WorkspaceArtifactVersion[],
  events: WorkspaceArtifactEvent[],
): WorkspaceArtifactDetailResponse {
  return {
    artifact: {
      id: "00000000-0000-4000-8000-000000000003",
      accountId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      slug: "site",
      title: "Site",
      description: null,
      status: "active",
      currentVersion,
      createdBySubjectId: "subject-1",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    },
    versions,
    events,
    versionsTruncated: false,
    eventsTruncated: false,
  };
}

function mutation(
  selectedVersion: WorkspaceArtifactVersion,
  currentVersion: WorkspaceArtifactVersion,
  selectedEvent: WorkspaceArtifactEvent,
): WorkspaceArtifactMutationResponse {
  return {
    artifact: detail(currentVersion, [], []).artifact,
    version: selectedVersion,
    event: selectedEvent,
    replayed: false,
  };
}

describe("workspace artifact provenance projection", () => {
  test("list responses never expose source-session provenance", () => {
    const sourceSessionId = "00000000-0000-4000-8000-000000000007";
    const response: WorkspaceArtifactListResponse = {
      artifacts: [
        detail(version("00000000-0000-4000-8000-000000000004", sourceSessionId), [], []).artifact,
      ],
      nextCursor: null,
      truncated: false,
    };

    const projected = redactWorkspaceArtifactListProvenance(response);
    expect(projected.artifacts[0]?.currentVersion).toMatchObject({
      sourceSessionId: null,
      sourceTurnId: null,
      sourceAttemptId: null,
      sourceExecutionGeneration: null,
    });
  });

  test("detail responses retain readable provenance and redact private relationships", async () => {
    const readable = "00000000-0000-4000-8000-000000000007";
    const privateSession = "00000000-0000-4000-8000-000000000008";
    const projected = await projectWorkspaceArtifactDetailProvenance(
      detail(
        version("00000000-0000-4000-8000-000000000004", privateSession),
        [
          version("00000000-0000-4000-8000-000000000004", privateSession),
          version("00000000-0000-4000-8000-000000000009", readable),
        ],
        [event("00000000-0000-4000-8000-000000000010", privateSession)],
      ),
      async (sessionId) => sessionId === readable,
    );

    expect(projected.artifact.currentVersion?.sourceSessionId).toBeNull();
    expect(projected.versions[0]?.sourceAttemptId).toBeNull();
    expect(projected.events[0]?.sourceExecutionGeneration).toBeNull();
    expect(projected.versions[1]?.sourceSessionId).toBe(readable);
  });

  test("selected versions use the same authorization-aware projection", async () => {
    const privateSession = "00000000-0000-4000-8000-000000000008";
    const projected = await projectWorkspaceArtifactVersionProvenance(
      version("00000000-0000-4000-8000-000000000004", privateSession),
      async () => false,
    );
    expect(projected.sourceSessionId).toBeNull();
    expect(projected.sourceTurnId).toBeNull();
  });

  test("mutation receipts redact every unreadable provenance-bearing member", async () => {
    const privateSession = "00000000-0000-4000-8000-000000000008";
    const readable = "00000000-0000-4000-8000-000000000007";
    const decisions: string[] = [];
    const projected = await projectWorkspaceArtifactMutationProvenance(
      mutation(
        version("00000000-0000-4000-8000-000000000004", privateSession),
        version("00000000-0000-4000-8000-000000000009", privateSession),
        event("00000000-0000-4000-8000-000000000010", readable),
      ),
      async (sessionId) => {
        decisions.push(sessionId);
        return sessionId === readable;
      },
    );

    expect(projected.artifact.currentVersion?.sourceSessionId).toBeNull();
    expect(projected.version.sourceAttemptId).toBeNull();
    expect(projected.event.sourceSessionId).toBe(readable);
    expect(decisions).toEqual([privateSession, readable]);
  });

  test("mutation receipts fail closed without hiding a committed mutation", async () => {
    const sourceSessionId = "00000000-0000-4000-8000-000000000008";
    const projected = await projectWorkspaceArtifactMutationProvenance(
      mutation(
        version("00000000-0000-4000-8000-000000000004", sourceSessionId),
        version("00000000-0000-4000-8000-000000000009", sourceSessionId),
        event("00000000-0000-4000-8000-000000000010", sourceSessionId),
      ),
      async () => {
        throw new Error("authorization temporarily unavailable");
      },
    );

    expect(projected.artifact.currentVersion?.sourceSessionId).toBeNull();
    expect(projected.version.sourceSessionId).toBeNull();
    expect(projected.event.sourceSessionId).toBeNull();
    expect(projected.replayed).toBeFalse();
  });
});
