import { z } from "zod";
export { HostMcpCreateSelections, type HostMcpCreateSelection } from "./index";
import { McpServerConnectionRef, SessionTenancyVisibility } from "./index";
import {
  ConnectionUseAuthoritySnapshot,
  IssueConnectionUseGrantRequest,
} from "./connection-authority";
import { ExternalIdentity } from "./external-identities";
export const HostMcpOwnerSubject = z.union([
  ExternalIdentity.shape.subjectId,
  z
    .string()
    .max(4096)
    .regex(/^user:[^\r\n\u0000]+$/),
]);

/** Credential-free, immutable destination and host connection selection. */
export const HostMcpBindingDefinition = z
  .object({
    serverId: z.string().min(1).max(256),
    destinationUrl: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
      }, "Host binding requires an HTTPS destination without userinfo or fragment")
      .transform((value) => new URL(value).toString()),
    connectionRef: McpServerConnectionRef,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.connectionRef.hostBinding)
      context.addIssue({
        code: "custom",
        path: ["connectionRef", "hostBinding"],
        message: "A binding definition cannot reference another binding",
      });
    if (value.connectionRef.authoritySource !== "host" || !value.connectionRef.connectionId)
      context.addIssue({
        code: "custom",
        path: ["connectionRef"],
        message: "Explicit host connection authority is required",
      });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536)
      context.addIssue({ code: "custom", message: "Host binding definition exceeds 64 KiB" });
  });
export type HostMcpBindingDefinition = z.infer<typeof HostMcpBindingDefinition>;

export const HostMcpBinding = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    ownerSubjectId: HostMcpOwnerSubject,
    authorizationRevision: z.number().int().positive().safe(),
    generation: z.number().int().positive().safe(),
    status: z.enum(["active", "revoked"]),
    definition: HostMcpBindingDefinition,
    createdAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type HostMcpBinding = z.infer<typeof HostMcpBinding>;

export const CreateHostMcpBindingRequest = z
  .object({
    operationId: z.string().uuid(),
    definition: HostMcpBindingDefinition,
  })
  .strict();
export type CreateHostMcpBindingRequest = z.infer<typeof CreateHostMcpBindingRequest>;

/** Internal owner-authorized issuance; never itself proves caller identity. */
const HostMcpDelegationGrant = IssueConnectionUseGrantRequest.superRefine((value, context) => {
  if (
    Boolean(value.sessionId) !== (value.expectedAuthorityEpoch != null) ||
    (value.expectedAuthorityEpoch != null && !Number.isSafeInteger(value.expectedAuthorityEpoch))
  ) {
    context.addIssue({
      code: "custom",
      message: "Host session grants require a matching safe authority epoch",
    });
  }
});
export const IssueHostMcpDelegationRequest = z
  .object({
    operationId: z.string().uuid(),
    bindingId: z.string().uuid(),
    expectedBindingGeneration: z.number().int().positive().safe(),
    grant: HostMcpDelegationGrant,
  })
  .strict();
export type IssueHostMcpDelegationRequest = z.infer<typeof IssueHostMcpDelegationRequest>;

export const HostMcpDelegation = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    ownerSubjectId: HostMcpOwnerSubject,
    ownerAuthorizationRevision: z.number().int().positive().safe(),
    bindingId: z.string().uuid(),
    bindingGeneration: z.number().int().positive().safe(),
    grant: HostMcpDelegationGrant,
    generation: z.number().int().positive().safe(),
    status: z.enum(["active", "revoked"]),
    createdAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type HostMcpDelegation = z.infer<typeof HostMcpDelegation>;

/** Internal admission evidence, not a caller-supplied permission or credential.
 * Persistence must construct this from live authenticated authority and freeze
 * it with accepted work. Runtime use must independently revalidate that work,
 * membership, binding and delegation. No API key is retained as execution rights.
 */
export const HostMcpAcceptedAuthority = z
  .object({
    version: z.literal(1),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    targetSessionVisibility: SessionTenancyVisibility,
    targetSessionAuthorityEpoch: z.number().int().positive().safe(),
    acceptedWork: ConnectionUseAuthoritySnapshot.shape.acceptedWork,
    bindingId: z.string().uuid(),
    bindingGeneration: z.number().int().positive().safe(),
    definition: HostMcpBindingDefinition,
    ownerSubjectId: HostMcpOwnerSubject,
    ownerOrganizationMembershipId: z.string().uuid(),
    ownerMembershipAuthorizationRevision: z.number().int().positive().safe(),
    delegationId: z.string().uuid(),
    delegationGeneration: z.number().int().positive().safe(),
    scheduledOrigin: z
      .object({
        taskId: z.string().uuid(),
        taskAuthorityRevision: z.number().int().positive().safe(),
        runId: z.string().uuid(),
      })
      .strict()
      .optional(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("direct") }).strict(),
      z.object({ kind: z.literal("scheduled_task") }).strict(),
      z
        .object({
          kind: z.literal("child_turn"),
          sessionId: z.string().uuid(),
          turnId: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("inherited_turn"),
          sessionId: z.string().uuid(),
          turnId: z.string().uuid(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.source.kind === "direct" && value.scheduledOrigin) ||
      (value.source.kind === "scheduled_task" &&
        (!value.scheduledOrigin ||
          value.acceptedWork.kind !== "scheduled_task" ||
          value.scheduledOrigin.taskId !== value.acceptedWork.taskId ||
          value.scheduledOrigin.runId !== value.acceptedWork.runId ||
          value.scheduledOrigin.taskAuthorityRevision !== value.acceptedWork.taskAuthorityRevision))
    )
      context.addIssue({
        code: "custom",
        message: "Scheduled host authority must retain its exact run origin",
      });
    if (
      value.acceptedWork.kind === "turn" &&
      value.source.kind === "inherited_turn" &&
      value.acceptedWork.turnId === value.source.turnId
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Accepted work cannot inherit from itself",
      });
    }
    if (
      value.acceptedWork.kind === "scheduled_task" &&
      !Number.isSafeInteger(value.acceptedWork.taskAuthorityRevision)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptedWork"],
        message: "Task authority revision must be a safe integer",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) {
      context.addIssue({ code: "custom", message: "Host accepted authority exceeds 64 KiB" });
    }
  });
export type HostMcpAcceptedAuthority = z.infer<typeof HostMcpAcceptedAuthority>;

/** Credential-free selection frozen on one immutable scheduled-task revision. */
export const HostMcpTaskAuthority = z
  .object({
    version: z.literal(1),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskAuthorityRevision: z.number().int().positive().safe(),
    taskExecutionDigest: z.string().regex(/^[0-9a-f]{64}$/),
    ownerSubjectId: HostMcpOwnerSubject,
    ownerOrganizationMembershipId: z.string().uuid(),
    ownerMembershipAuthorizationRevision: z.number().int().positive().safe(),
    bindingId: z.string().uuid(),
    bindingGeneration: z.number().int().positive().safe(),
    delegationId: z.string().uuid(),
    delegationGeneration: z.number().int().positive().safe(),
    definition: HostMcpBindingDefinition,
    context: SessionTenancyVisibility,
  })
  .strict();
export type HostMcpTaskAuthority = z.infer<typeof HostMcpTaskAuthority>;
