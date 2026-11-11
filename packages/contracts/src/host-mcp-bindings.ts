import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
export { HostMcpCreateSelections, type HostMcpCreateSelection } from "./index";
import {
  McpServerConnectionRef,
  SessionTenancyVisibility,
  ManagedUserResourceGrantMode,
  stableJson,
} from "./index";
import { ConnectionUseAuthoritySnapshot } from "./connection-authority";
import { ExternalIdentity } from "./external-identities";
export const HostMcpOwnerSubject = /* @__PURE__ */ defineSchema(() =>
  z.union([
    ExternalIdentity.shape.subjectId,
    z
      .string()
      .max(4096)
      .regex(/^user:[^\r\n\u0000]+$/),
  ]),
);

/** Credential-free, immutable destination and host connection selection. */
export const HostMcpBindingDefinition = /* @__PURE__ */ defineSchema(() =>
  z
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
    }),
);
export type HostMcpBindingDefinition = z.infer<typeof HostMcpBindingDefinition>;

/** Configuration ceiling, never execution authority. The complete destination
 * and provider/scope/resource selection stay exact; only the account identifier
 * is chosen by a captured owner grant in explicit accepted-turn mode. */
export type HostMcpBindingSelection = {
  serverId: string;
  destinationUrl: string;
  connectionRef: McpServerConnectionRef;
};

export function hostMcpBindingMatchesSelection(
  binding: { id: string; generation: number; definition: HostMcpBindingDefinition },
  selection: HostMcpBindingSelection,
): boolean {
  const parsed = McpServerConnectionRef.safeParse(selection.connectionRef);
  if (!parsed.success || !parsed.data.hostBinding) return false;
  const { hostBinding, ...configuredRef } = parsed.data;
  const definition = HostMcpBindingDefinition.safeParse(binding.definition);
  if (!definition.success) return false;
  let destinationUrl: string;
  try {
    destinationUrl = new URL(selection.destinationUrl).toString();
  } catch {
    return false;
  }
  if (
    selection.serverId !== definition.data.serverId ||
    destinationUrl !== definition.data.destinationUrl
  )
    return false;
  if ("selection" in hostBinding) {
    const { connectionId: _connectionId, ...selectedRef } = definition.data.connectionRef;
    return stableJson(configuredRef) === stableJson(selectedRef);
  }
  return (
    binding.id === hostBinding.bindingId &&
    binding.generation === hostBinding.generation &&
    stableJson(configuredRef) === stableJson(definition.data.connectionRef)
  );
}

export const HostMcpBinding = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      ownerSubjectId: HostMcpOwnerSubject,
      authorizationRevision: primitives.positiveInteger.safe(),
      generation: primitives.positiveInteger.safe(),
      status: z.enum(["active", "revoked"]),
      definition: HostMcpBindingDefinition,
      createdAt: primitives.string.datetime({ offset: true }),
      revokedAt: primitives.string.datetime({ offset: true }).nullable(),
    })
    .strict(),
);
export type HostMcpBinding = z.infer<typeof HostMcpBinding>;

export const CreateHostMcpBindingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      definition: HostMcpBindingDefinition,
    })
    .strict(),
);
export type CreateHostMcpBindingRequest = z.infer<typeof CreateHostMcpBindingRequest>;

const HostMcpGrantRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      scope: z.literal("user"),
      mode: ManagedUserResourceGrantMode,
      context: SessionTenancyVisibility,
      sessionId: z.string().uuid().nullable().optional(),
      expectedAuthorityEpoch: z.number().int().positive().nullable().optional(),
      workspaceSharedAcknowledged: primitives.boolean.default(false),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.context === "workspace_shared" && !value.workspaceSharedAcknowledged) {
        context.addIssue({
          code: "custom",
          path: ["workspaceSharedAcknowledged"],
          message: "workspace_shared requires durable shared-output acknowledgement",
        });
      }
      if (value.mode === "always" && (value.sessionId || value.expectedAuthorityEpoch)) {
        context.addIssue({ code: "custom", path: ["sessionId"], message: "always is unbound" });
      }
      if (value.mode === "session" && (!value.sessionId || !value.expectedAuthorityEpoch)) {
        context.addIssue({
          code: "custom",
          path: ["sessionId"],
          message: "session requires a target session and expectedAuthorityEpoch",
        });
      }
    }),
);

/** Internal owner-authorized issuance; never itself proves caller identity. */
const HostMcpDelegationGrant = /* @__PURE__ */ defineSchema(() =>
  HostMcpGrantRequest.superRefine((value, context) => {
    if (
      Boolean(value.sessionId) !== (value.expectedAuthorityEpoch != null) ||
      (value.expectedAuthorityEpoch != null && !Number.isSafeInteger(value.expectedAuthorityEpoch))
    ) {
      context.addIssue({
        code: "custom",
        message: "Host session grants require a matching safe authority epoch",
      });
    }
  }),
);
export const IssueHostMcpDelegationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      bindingId: primitives.uuid,
      expectedBindingGeneration: primitives.positiveInteger.safe(),
      grant: HostMcpDelegationGrant,
    })
    .strict(),
);
export type IssueHostMcpDelegationRequest = z.infer<typeof IssueHostMcpDelegationRequest>;

export const HostMcpDelegation = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      ownerSubjectId: HostMcpOwnerSubject,
      ownerAuthorizationRevision: primitives.positiveInteger.safe(),
      bindingId: primitives.uuid,
      bindingGeneration: primitives.positiveInteger.safe(),
      grant: HostMcpDelegationGrant,
      generation: primitives.positiveInteger.safe(),
      status: z.enum(["active", "revoked"]),
      createdAt: primitives.string.datetime({ offset: true }),
      revokedAt: primitives.string.datetime({ offset: true }).nullable(),
    })
    .strict(),
);
export type HostMcpDelegation = z.infer<typeof HostMcpDelegation>;

/** Internal admission evidence, not a caller-supplied permission or credential.
 * Persistence must construct this from live authenticated authority and freeze
 * it with accepted work. Runtime use must independently revalidate that work,
 * membership, binding and delegation. No API key is retained as execution rights.
 */
export const HostMcpAcceptedAuthority = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(1),
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      targetSessionId: primitives.uuid,
      targetSessionVisibility: SessionTenancyVisibility,
      targetSessionAuthorityEpoch: primitives.positiveInteger.safe(),
      acceptedWork: ConnectionUseAuthoritySnapshot.shape.acceptedWork,
      bindingId: primitives.uuid,
      bindingGeneration: primitives.positiveInteger.safe(),
      definition: HostMcpBindingDefinition,
      ownerSubjectId: HostMcpOwnerSubject,
      ownerOrganizationMembershipId: primitives.uuid,
      ownerMembershipAuthorizationRevision: primitives.positiveInteger.safe(),
      delegationId: primitives.uuid,
      delegationGeneration: primitives.positiveInteger.safe(),
      scheduledOrigin: z
        .object({
          taskId: primitives.uuid,
          taskAuthorityRevision: primitives.positiveInteger.safe(),
          runId: primitives.uuid,
        })
        .strict()
        .optional(),
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("direct") }).strict(),
        z.object({ kind: z.literal("scheduled_task") }).strict(),
        z
          .object({
            kind: z.literal("child_turn"),
            sessionId: primitives.uuid,
            turnId: primitives.uuid,
          })
          .strict(),
        z
          .object({
            kind: z.literal("inherited_turn"),
            sessionId: primitives.uuid,
            turnId: primitives.uuid,
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
            value.scheduledOrigin.taskAuthorityRevision !==
              value.acceptedWork.taskAuthorityRevision))
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
    }),
);
export type HostMcpAcceptedAuthority = z.infer<typeof HostMcpAcceptedAuthority>;

/** Credential-free selection frozen on one immutable scheduled-task revision. */
export const HostMcpTaskAuthority = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(1),
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      taskId: primitives.uuid,
      taskAuthorityRevision: primitives.positiveInteger.safe(),
      taskExecutionDigest: primitives.string.regex(/^[0-9a-f]{64}$/),
      ownerSubjectId: HostMcpOwnerSubject,
      ownerOrganizationMembershipId: primitives.uuid,
      ownerMembershipAuthorizationRevision: primitives.positiveInteger.safe(),
      bindingId: primitives.uuid,
      bindingGeneration: primitives.positiveInteger.safe(),
      delegationId: primitives.uuid,
      delegationGeneration: primitives.positiveInteger.safe(),
      definition: HostMcpBindingDefinition,
      context: SessionTenancyVisibility,
    })
    .strict(),
);
export type HostMcpTaskAuthority = z.infer<typeof HostMcpTaskAuthority>;
