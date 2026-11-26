import { z } from "zod";
import { defineSchema } from "./define-schema";

export const ACCOUNT_DELETION_LAST_OWNER = "LAST_ORGANIZATION_OWNER" as const;

export const AccountDeletionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.uuid(),
    operationId: z.uuid(),
    status: z.enum(["pending", "running", "blocked", "completed"]),
    requestedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
);
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequest>;

const Organization = /* @__PURE__ */ defineSchema(() =>
  z.object({ organizationId: z.uuid(), name: z.string() }),
);

export const AccountDeletionBlocker = /* @__PURE__ */ defineSchema(() =>
  Organization.extend({ code: z.literal(ACCOUNT_DELETION_LAST_OWNER) }),
);
export type AccountDeletionBlocker = z.infer<typeof AccountDeletionBlocker>;

export const AccountDeletionPreview = /* @__PURE__ */ defineSchema(() =>
  z.object({
    closeOrganizations: z.array(Organization),
    leaveOrganizations: z.array(
      Organization.extend({
        retention: z.object({
          mode: z.enum(["retain", "delete_after"]),
          days: z.number().int().nullable(),
        }),
      }),
    ),
    blockers: z.array(AccountDeletionBlocker),
    request: AccountDeletionRequest.nullable(),
  }),
);
export type AccountDeletionPreview = z.infer<typeof AccountDeletionPreview>;

export const StartAccountDeletionRequest = /* @__PURE__ */ defineSchema(() =>
  z.strictObject({ confirm: z.literal("DELETE"), operationId: z.uuid() }),
);
export type StartAccountDeletionRequest = z.infer<typeof StartAccountDeletionRequest>;

export const StartAccountDeletionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ request: AccountDeletionRequest }),
);
export type StartAccountDeletionResponse = z.infer<typeof StartAccountDeletionResponse>;
