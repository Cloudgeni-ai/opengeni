import { defineSchema } from "./define-schema";
import { z } from "zod";
import { TurnExecutionPolicyV1 } from "./index";

export const TURN_SERVING_POLICY_METADATA_KEY = "turnServingPolicyV1" as const;
export const TURN_PENDING_SERVING_POLICY_METADATA_KEY = "turnPendingServingPolicyV1" as const;

const ServingReason = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "initial",
    "sticky",
    "pinned",
    "reselected_cold",
    "failover_same_provider",
    "failover_cross_provider",
    "return_to_preferred",
  ]),
);

/** One immutable serving receipt, not a replacement for the accepted policy.
 * The lazy reference keeps the contracts barrel free of initialization cycles.
 * Connection ids are references only; no credential material belongs here.
 */
export const TurnServingPolicyV1 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      schemaVersion: z.literal(1),
      policy: z.lazy(() => TurnExecutionPolicyV1),
      executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      /** Selection reference; advisory until the generation is placed. */
      connectionId: z.string().uuid(),
      reason: ServingReason,
      /** Highest session history position at recording, including inactive rows.
       * Fractional positions exist in historical compaction layouts. A revision
       * applies strictly AFTER this boundary, never to the row at the boundary.
       */
      historyPosition: z.number().finite().nonnegative(),
    })
    .strict()
    .superRefine((revision, context) => {
      if (revision.policy.credentialRestriction !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["policy", "credentialRestriction"],
          message: "Restricted policies cannot switch",
        });
      }
      if (
        revision.policy.billing.metering !== "external" ||
        revision.policy.credentialSource.kind === "deployment"
      ) {
        context.addIssue({
          code: "custom",
          path: ["policy", "billing"],
          message: "Serving revisions require externally funded connected access",
        });
      }
    }),
);
export type TurnServingPolicyV1 = z.infer<typeof TurnServingPolicyV1>;

/** A recovery proposal, NOT provenance. Its history boundary is assigned only
 * when a newer claimed generation commits a serving revision. C2 will stage it
 * atomically with recovery using the transaction-local database helper.
 */
export const TurnPendingServingPolicyV1 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      schemaVersion: z.literal(1),
      sourceExecutionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      sourceAttemptId: z.string().uuid(),
      policy: z.lazy(() => TurnExecutionPolicyV1),
      connectionId: z.string().uuid(),
      reason: ServingReason,
    })
    .strict()
    .superRefine((target, context) => {
      const candidate = TurnServingPolicyV1.safeParse({
        schemaVersion: 1,
        policy: target.policy,
        connectionId: target.connectionId,
        reason: target.reason,
        executionGeneration: target.sourceExecutionGeneration,
        historyPosition: 0,
      });
      if (!candidate.success)
        context.addIssue({ code: "custom", message: "Invalid pending serving selection" });
    }),
);
export type TurnPendingServingPolicyV1 = z.infer<typeof TurnPendingServingPolicyV1>;

export function readTurnPendingServingPolicyV1(
  metadata: unknown,
): TurnPendingServingPolicyV1 | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Malformed pending serving metadata");
  if (!Object.prototype.hasOwnProperty.call(metadata, TURN_PENDING_SERVING_POLICY_METADATA_KEY))
    return null;
  const parsed = TurnPendingServingPolicyV1.safeParse(
    (metadata as Record<string, unknown>)[TURN_PENDING_SERVING_POLICY_METADATA_KEY],
  );
  if (!parsed.success) throw new Error("Malformed pending serving policy");
  return parsed.data;
}

const ServingRevisions = /* @__PURE__ */ defineSchema(() =>
  z
    .array(TurnServingPolicyV1)
    .nonempty()
    .superRefine((revisions, context) => {
      for (let index = 1; index < revisions.length; index++) {
        const previous = revisions[index - 1]!;
        const current = revisions[index]!;
        if (
          current.executionGeneration <= previous.executionGeneration ||
          current.historyPosition < previous.historyPosition
        ) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "Serving revisions must advance generation and never move history backwards",
          });
        }
      }
    }),
);

export type TurnServingPolicyReadV1 =
  | { kind: "absent" }
  | { kind: "valid"; revisions: TurnServingPolicyV1[] };

/** Only absence is legacy. Malformed present metadata fails closed, without
 * reflecting untrusted values (which might contain credentials) into errors.
 */
export function readTurnServingPolicyV1(metadata: unknown): TurnServingPolicyReadV1 {
  if (metadata === null || metadata === undefined) return { kind: "absent" };
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Malformed turn serving policy metadata");
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, TURN_SERVING_POLICY_METADATA_KEY))
    return { kind: "absent" };
  const parsed = ServingRevisions.safeParse(
    (metadata as Record<string, unknown>)[TURN_SERVING_POLICY_METADATA_KEY],
  );
  if (!parsed.success) throw new Error("Malformed turn serving policy revisions");
  return { kind: "valid", revisions: parsed.data };
}

/** D-39: the first receipt establishes the baseline. Reclaims, account-only
 * rotations and reasoning changes do not spend the model/provider bound.
 * Combine this with the all-provider refusal count at the recovery boundary.
 */
export function countTurnServingPolicyChangesV1(revisions: readonly TurnServingPolicyV1[]): number {
  let count = 0;
  for (let index = 1; index < revisions.length; index++) {
    const previous = revisions[index - 1]!.policy;
    const current = revisions[index]!.policy;
    if (
      previous.providerId !== current.providerId ||
      previous.productModelId !== current.productModelId
    )
      count++;
  }
  return count;
}
