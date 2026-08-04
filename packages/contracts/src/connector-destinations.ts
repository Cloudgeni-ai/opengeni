import { z } from "zod";

export const ConnectorDocumentDestinationAuthority = z.enum([
  "organization",
  "workspace",
  "personal",
]);
export type ConnectorDocumentDestinationAuthority = z.infer<
  typeof ConnectorDocumentDestinationAuthority
>;

export const ConnectorDocumentDestinationSelection = z.object({
  authorityKind: ConnectorDocumentDestinationAuthority,
  collectionId: z.string().uuid().nullable().default(null),
});
export type ConnectorDocumentDestinationSelection = z.infer<
  typeof ConnectorDocumentDestinationSelection
>;

export const ConnectorDocumentDestination = z
  .object({
    authorityKind: ConnectorDocumentDestinationAuthority,
    authorityAccountId: z.string().uuid(),
    authorityWorkspaceId: z.string().uuid().nullable(),
    authoritySubjectId: z.string().trim().min(1).max(1024).nullable(),
    collectionId: z.string().uuid().nullable().default(null),
  })
  .superRefine((destination, context) => {
    if (destination.authorityKind === "organization") {
      if (destination.authorityWorkspaceId !== null || destination.authoritySubjectId !== null) {
        context.addIssue({
          code: "custom",
          message: "organization connector destinations cannot bind workspace or subject authority",
        });
      }
      return;
    }
    if (destination.authorityWorkspaceId === null) {
      context.addIssue({
        code: "custom",
        message: "workspace and personal connector destinations require workspace authority",
      });
    }
    if (
      destination.authorityKind === "workspace" &&
      destination.authoritySubjectId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "workspace connector destinations cannot bind subject authority",
      });
    }
    if (
      destination.authorityKind === "personal" &&
      destination.authoritySubjectId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "personal connector destinations require immutable subject authority",
      });
    }
  });
export type ConnectorDocumentDestination = z.infer<typeof ConnectorDocumentDestination>;

export function bindConnectorDocumentDestination(
  selection: ConnectorDocumentDestinationSelection,
  context: { accountId: string; workspaceId: string; initiatingSubjectId: string },
): ConnectorDocumentDestination {
  return ConnectorDocumentDestination.parse({
    authorityKind: selection.authorityKind,
    authorityAccountId: context.accountId,
    authorityWorkspaceId:
      selection.authorityKind === "organization" ? null : context.workspaceId,
    authoritySubjectId:
      selection.authorityKind === "personal" ? context.initiatingSubjectId : null,
    collectionId: selection.collectionId,
  });
}

export function legacyWorkspaceConnectorDocumentDestination(context: {
  accountId: string;
  workspaceId: string;
}): ConnectorDocumentDestination {
  return bindConnectorDocumentDestination(
    { authorityKind: "workspace", collectionId: null },
    { ...context, initiatingSubjectId: "legacy-workspace-fallback" },
  );
}

export function resolveConnectorDocumentDestination(
  value: unknown,
  context: {
    accountId: string;
    workspaceId: string;
    connectionSubjectId?: string | null | undefined;
  },
): ConnectorDocumentDestination {
  if (value === undefined || value === null) {
    return legacyWorkspaceConnectorDocumentDestination(context);
  }
  const destination = ConnectorDocumentDestination.parse(value);
  if (destination.authorityAccountId !== context.accountId) {
    throw new Error("connector destination organization authority mismatch");
  }
  if (
    destination.authorityKind !== "organization" &&
    destination.authorityWorkspaceId !== context.workspaceId
  ) {
    throw new Error("connector destination workspace authority mismatch");
  }
  if (
    destination.authorityKind === "personal" &&
    destination.authoritySubjectId !== context.connectionSubjectId
  ) {
    throw new Error("connector destination personal authority mismatch");
  }
  return destination;
}

export function connectorDestinationDocumentAuthority(
  destination: ConnectorDocumentDestination,
): {
  authorityKind: ConnectorDocumentDestinationAuthority;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
} {
  return {
    authorityKind: destination.authorityKind,
    authorityWorkspaceId: destination.authorityWorkspaceId,
    authoritySubjectId: destination.authoritySubjectId,
  };
}