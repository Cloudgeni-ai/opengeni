import { z } from "zod";
import { IntegrationInstanceKey, IntegrationSource } from "./index";

const opaqueId = z.string().min(1).max(512);
export const ConnectOwnership = z.enum(["personal", "workspace"]);
export type ConnectOwnership = z.infer<typeof ConnectOwnership>;
export const ConnectProvider = z
  .object({
    id: opaqueId,
    label: z.string().min(1).max(256),
    family: opaqueId,
    readiness: z.enum(["available", "needs_configuration", "operator_only", "unsupported"]),
    reason: z.string().max(1024).optional(),
    ownership: z.array(ConnectOwnership).max(2),
    setup: z
      .array(
        z.enum(["none", "oauth", "credentials", "device", "installation", "openapi", "graphql"]),
      )
      .max(7),
  })
  .strict();
export type ConnectProvider = z.infer<typeof ConnectProvider>;
export const ConnectAccount = z
  .object({
    id: opaqueId,
    providerId: opaqueId,
    version: z.number().int().positive().optional(),
    label: z.string().max(256),
    ownership: ConnectOwnership,
    status: z.enum(["connected", "auth_needed", "disabled"]),
  })
  .strict();
export type ConnectAccount = z.infer<typeof ConnectAccount>;
export const ConnectResource = z
  .object({ id: opaqueId, label: z.string().max(512), kind: opaqueId })
  .strict();
export type ConnectResource = z.infer<typeof ConnectResource>;
export const ConnectNextAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authorize"), url: z.string().url().max(16_384) }).strict(),
  z
    .object({
      type: z.literal("credentials"),
      fields: z
        .array(
          z
            .object({
              name: opaqueId,
              label: z.string().max(256),
              required: z.boolean(),
              secret: z.boolean(),
              options: z
                .array(z.object({ value: opaqueId, label: z.string().max(512) }).strict())
                .max(1000)
                .optional(),
            })
            .strict(),
        )
        .max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      pollAfterMs: z.number().int().min(250).max(60_000),
      userCode: z.string().max(128).optional(),
      verificationUrl: z.string().url().max(2048).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("select_account"), accounts: z.array(ConnectAccount).max(100) })
    .strict(),
  z
    .object({
      type: z.literal("select_resources"),
      resources: z.array(ConnectResource).max(100),
      cursor: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("preview"),
      previewId: opaqueId,
      contentHash: opaqueId,
      operations: z.array(ConnectResource).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("none") }).strict(),
]);
export type ConnectNextAction = z.infer<typeof ConnectNextAction>;
export const ConnectInstallationTarget = z
  .object({
    instanceKey: IntegrationInstanceKey,
    displayName: z.string().min(1).max(200),
    expectedInstanceVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ConnectInstallationTarget = z.infer<typeof ConnectInstallationTarget>;
export const ConnectAttemptState = z.enum([
  "ready",
  "requires_user_action",
  "credential_input",
  "provider_wait",
  "account_selection",
  "resource_selection",
  "preview",
  "installing",
  "connected_but_incomplete",
  "complete",
  "cancelled",
  "expired",
  "failed",
  "uncertain",
]);
export const ConnectAttempt = z
  .object({
    id: opaqueId,
    workspaceId: opaqueId,
    providerId: opaqueId,
    ownership: ConnectOwnership,
    revision: z.number().int().positive(),
    state: ConnectAttemptState,
    credentialsCommitted: z.boolean(),
    integrationInstalled: z.boolean(),
    completionRequirement: z.enum(["connection", "integration", "provider_setup"]),
    nextAction: ConnectNextAction,
    expiresAt: z.string().datetime({ offset: true }),
    account: ConnectAccount.optional(),
    installationTarget: ConnectInstallationTarget.optional(),
    source: IntegrationSource.optional(),
    error: z
      .object({ code: opaqueId, message: z.string().max(2048), retryable: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state === "complete" &&
      value.completionRequirement === "integration" &&
      !value.integrationInstalled
    ) {
      context.addIssue({
        code: "custom",
        message: "Complete setup requires an installed integration",
      });
    }
    if (
      value.state === "complete" &&
      value.completionRequirement === "connection" &&
      !value.credentialsCommitted
    ) {
      context.addIssue({
        code: "custom",
        message: "Connection setup requires committed credentials",
      });
    }
    if (
      ["complete", "cancelled", "expired"].includes(value.state) &&
      value.nextAction.type !== "none"
    ) {
      context.addIssue({ code: "custom", message: "A terminal setup has no next action" });
    }
  });
export type ConnectAttempt = z.infer<typeof ConnectAttempt>;
export const ConnectAdvance = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("credentials"),
      values: z.record(z.string().max(256), z.string().max(16_384)),
    })
    .strict(),
  z.object({ type: z.literal("account"), accountId: opaqueId }).strict(),
  z.object({ type: z.literal("resources"), resourceIds: z.array(opaqueId).max(1000) }).strict(),
  z
    .object({
      type: z.literal("install"),
      previewId: opaqueId,
      contentHash: opaqueId,
      operationIds: z.array(opaqueId).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("retry") }).strict(),
]);
export type ConnectAdvance = z.infer<typeof ConnectAdvance>;
export const ConnectOperationRequest = z
  .object({
    expectedRevision: z.number().int().positive().safe(),
    idempotencyKey: opaqueId,
  })
  .strict();
export const AdvanceConnectRequest = ConnectOperationRequest.extend({ action: ConnectAdvance });
export const BeginConnectRequest = z
  .object({
    providerId: opaqueId,
    ownership: ConnectOwnership,
    // URL parsing validates separately; never transform this original string.
    returnUrl: z.string().min(1).max(4096),
    idempotencyKey: opaqueId,
    reconnectAccountId: opaqueId.optional(),
    installationTarget: ConnectInstallationTarget.optional(),
  })
  .strict();
