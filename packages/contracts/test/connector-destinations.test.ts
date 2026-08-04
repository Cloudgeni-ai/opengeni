import { describe, expect, test } from "bun:test";

import {
  ConnectorDocumentDestination,
  bindConnectorDocumentDestination,
  connectorDestinationDocumentAuthority,
  connectorDocumentDestinationCollectionId,
  resolveConnectorDocumentDestination,
} from "../src/connector-destinations";

const accountId = "00000000-0000-4000-8000-000000000156";
const workspaceId = "00000000-0000-4000-8000-000000000157";
const subjectId = "user:connector-owner";

describe("connector document destinations", () => {
  test.each([
    ["organization", null, null],
    ["workspace", workspaceId, null],
    ["personal", workspaceId, subjectId],
  ] as const)("binds immutable %s authority", (authorityKind, authorityWorkspaceId, authoritySubjectId) => {
    const destination = bindConnectorDocumentDestination(
      { authorityKind, collectionId: null },
      { accountId, workspaceId, initiatingSubjectId: subjectId },
    );
    expect(destination).toEqual({
      authorityKind,
      authorityAccountId: accountId,
      authorityWorkspaceId,
      authoritySubjectId,
      collectionId: null,
    });
    expect(connectorDestinationDocumentAuthority(destination)).toEqual({
      authorityKind,
      authorityWorkspaceId,
      authoritySubjectId,
    });
  });

  test("fails closed on mismatched tenant, workspace, and personal subjects", () => {
    const personal = bindConnectorDocumentDestination(
      { authorityKind: "personal", collectionId: null },
      { accountId, workspaceId, initiatingSubjectId: subjectId },
    );
    expect(() =>
      resolveConnectorDocumentDestination(personal, {
        accountId: "00000000-0000-4000-8000-000000000999",
        workspaceId,
        connectionSubjectId: subjectId,
      }),
    ).toThrow("organization authority mismatch");
    expect(() =>
      resolveConnectorDocumentDestination(personal, {
        accountId,
        workspaceId: "00000000-0000-4000-8000-000000000998",
        connectionSubjectId: subjectId,
      }),
    ).toThrow("workspace authority mismatch");
    expect(() =>
      resolveConnectorDocumentDestination(personal, {
        accountId,
        workspaceId,
        connectionSubjectId: "user:other",
      }),
    ).toThrow("personal authority mismatch");
  });

  test("defaults missing legacy config to the current workspace without collection authority", () => {
    expect(
      resolveConnectorDocumentDestination(undefined, { accountId, workspaceId }),
    ).toEqual({
      authorityKind: "workspace",
      authorityAccountId: accountId,
      authorityWorkspaceId: workspaceId,
      authoritySubjectId: null,
      collectionId: null,
    });
  });

  test("keeps optional collection organization separate from document authority", () => {
    const collectionId = "00000000-0000-4000-8000-000000000158";
    const destination = bindConnectorDocumentDestination(
      { authorityKind: "personal", collectionId },
      { accountId, workspaceId, initiatingSubjectId: subjectId },
    );
    expect(destination.collectionId).toBe(collectionId);
    expect(
      connectorDocumentDestinationCollectionId(
        destination,
        "00000000-0000-4000-8000-000000000999",
      ),
    ).toBe(collectionId);
    expect(connectorDestinationDocumentAuthority(destination)).toEqual({
      authorityKind: "personal",
      authorityWorkspaceId: workspaceId,
      authoritySubjectId: subjectId,
    });
  });

  test("resolves the internal Default collection when no optional collection is selected", () => {
    const defaultCollectionId = "00000000-0000-4000-8000-000000000160";
    const destination = bindConnectorDocumentDestination(
      { authorityKind: "workspace", collectionId: null },
      { accountId, workspaceId, initiatingSubjectId: subjectId },
    );
    expect(connectorDocumentDestinationCollectionId(destination, defaultCollectionId)).toBe(
      defaultCollectionId,
    );
  });

  test("rejects partial authority tuples", () => {
    expect(() =>
      ConnectorDocumentDestination.parse({
        authorityKind: "personal",
        authorityAccountId: accountId,
        authorityWorkspaceId: workspaceId,
        authoritySubjectId: null,
        collectionId: null,
      }),
    ).toThrow();
  });
});