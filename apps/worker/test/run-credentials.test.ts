import { describe, expect, test } from "bun:test";
import type { Session, SessionTurn } from "@opengeni/contracts";
import type { NormalizedRunCredentialMaterial } from "@opengeni/runtime";
import {
  buildRunCredentialsRequest,
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
} from "../src/activities/run-credentials";

describe("host-owned run credential request", () => {
  test("carries frozen authority, lineage, backend, OS, and informational variable-set context", () => {
    const session = {
      id: "00000000-0000-4000-8000-000000000001",
      parentSessionId: "00000000-0000-4000-8000-000000000002",
      sandboxGroupId: "00000000-0000-4000-8000-000000000009",
      sandboxOs: "linux",
    } as Session;
    const turn = {
      id: "00000000-0000-4000-8000-000000000003",
      executionGeneration: 7,
      initiator: { kind: "subject", subjectId: "host:user:42", label: "Operator" },
      initiatorContext: { source: "embedded-host", delegatedBy: "host:user:7" },
      sandboxOs: "macos",
    } as SessionTurn;
    const request = buildRunCredentialsRequest({
      accountId: "00000000-0000-4000-8000-000000000004",
      workspaceId: "00000000-0000-4000-8000-000000000005",
      session,
      turn,
      attemptId: "00000000-0000-4000-8000-000000000006",
      rootSessionId: "00000000-0000-4000-8000-000000000007",
      sandboxGroupId: "00000000-0000-4000-8000-000000000009",
      effectiveSandboxBackend: "selfhosted",
      variableSet: {
        id: "00000000-0000-4000-8000-000000000008",
        name: "informational-only",
      },
      purpose: "renewal",
      forceRefresh: true,
    });

    expect(request).toMatchObject({
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      rootSessionId: "00000000-0000-4000-8000-000000000007",
      turnId: turn.id,
      executionGeneration: 7,
      initiator: turn.initiator,
      initiatorContext: turn.initiatorContext,
      effectiveSandboxBackend: "selfhosted",
      sandboxOs: "macos",
      purpose: "renewal",
      forceRefresh: true,
      variableSet: { name: "informational-only" },
    });
  });

  test("projects auth-needed state into non-secret model and UI surfaces", () => {
    const material: NormalizedRunCredentialMaterial = {
      environment: {},
      files: [],
      fileEnvironment: {},
      expiresAt: null,
      redactions: [],
      authNeeded: [
        {
          reason: "insufficient_scope",
          providerDomain: "cloud.example",
          connectionId: "host:connection:42",
          scopes: ["infrastructure:write"],
          authorizationUrl: "https://cloud.example/connect",
          message: "Reconnect the cloud account.",
        },
      ],
    };
    expect(runCredentialAuthNeededPayloads(material)).toEqual([
      {
        credentialClass: "run",
        reason: "insufficient_scope",
        providerDomain: "cloud.example",
        connectionId: "host:connection:42",
        scopes: ["infrastructure:write"],
        authorizationUrl: "https://cloud.example/connect",
        message: "Reconnect the cloud account.",
      },
    ]);
    expect(runCredentialModelNote(material)).toContain("cloud.example");
    expect(runCredentialModelNote(material)).not.toContain("host:connection:42");
  });
});
