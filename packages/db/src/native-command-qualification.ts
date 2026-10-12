import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  canonicalModalCheckpointProviderBinding,
  NativeBrokerArtifactPin,
  NativeBrokerCreatePlan,
  CommandSupervisionProtocol,
  type NativeBrokerCommandProtocol,
} from "@opengeni/contracts";
import { withRlsContext, isTransactionHandle, type Database } from "./database";
import { assertNativeCommandQualificationReady } from "./native-command-readiness";

const QualificationBase = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  workspaceId: z.uuid(),
  creatorSubjectId: z.string().min(1),
  // Exact canonical HTTP create key: preserve every character, including spaces.
  createIdempotencyKey: z.string().min(1).max(200),
  activationGeneration: z.number().int().positive().safe(),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  imageRef: z
    .string()
    .regex(
      /^(?:ghcr\.io\/cloudgeni-ai|opengenipublicneuacr\.azurecr\.io)\/opengeni-desktop@sha256:[a-f0-9]{64}$/u,
    ),
  providerImageId: z.string().regex(/^im-[A-Za-z0-9_-]{1,200}$/u),
  providerBindingKey: z
    .string()
    .min(1)
    .max(1024)
    .refine((key) => {
      try {
        return canonicalModalCheckpointProviderBinding(JSON.parse(key))?.key === key;
      } catch {
        return false;
      }
    }, "Qualification requires a canonical authenticated provider namespace"),
  acceptanceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
const Qualification = z.union([
  QualificationBase.extend({
    protocols: z.tuple([z.literal("native-subreaper-v1"), z.literal("native-subreaper-pty-v1")]),
    brokerArtifact: z.undefined().optional(),
  }),
  QualificationBase.extend({
    protocols: z.tuple([
      z.literal("native-subreaper-broker-channel-v1"),
      z.literal("native-subreaper-broker-channel-pty-v1"),
    ]),
    brokerArtifact: NativeBrokerArtifactPin,
  }),
]);

export type NativeCommandBirthQualification = z.infer<typeof Qualification>;
export type NativeCommandQualification = NativeCommandBirthQualification & {
  enrollmentEnabled: boolean;
};
export type NativeCommandQualificationScope = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
};
export type NativeCommandProviderQualification =
  | { status: "legacy" }
  | { status: "enrolled"; qualification: NativeCommandBirthQualification }
  | { status: "blocked"; reason: string; qualification?: NativeCommandBirthQualification };
type LoadedNativeCommandProviderDecision =
  | Exclude<NativeCommandProviderQualification, { status: "blocked" }>
  | { status: "blocked"; reason: string; qualification: NativeCommandBirthQualification };

const BootstrapAdmissionInput = z
  .object({
    accountId: z.uuid(),
    workspaceId: z.uuid(),
    sandboxGroupId: z.uuid(),
    leaseId: z.uuid(),
    createOperationId: z.string().min(1).max(200),
    sandboxId: z.string().regex(/^sb-[A-Za-z0-9_-]{1,200}$/u),
    sourceSha: QualificationBase.shape.sourceSha,
    providerBindingKey: QualificationBase.shape.providerBindingKey,
  })
  .strict();
export type NativeBrokerBootstrapAdmissionInput = z.infer<typeof BootstrapAdmissionInput>;

/** Read-only creation proof, not command authority. Source and namespace come
 * from the immutable host build and authenticated provider. Plan and artifact
 * are derived from the owner-qualified birth and original physical admission,
 * never from public metadata or an echo from the guest. No provider I/O here. */
export async function loadNativeBrokerBootstrapAdmission(
  db: Database,
  input: NativeBrokerBootstrapAdmissionInput,
) {
  if (isTransactionHandle(db))
    throw new Error("Native broker bootstrap admission requires an outer commit boundary");
  const scope = BootstrapAdmissionInput.parse(input);
  return withRlsContext(db, scope, async (tx) => {
    await assertNativeCommandQualificationReady(tx);
    const [row] = await tx.execute<{ admission: unknown }>(sql`
      select native_broker_bootstrap_admission(${scope.accountId}::uuid,
        ${scope.workspaceId}::uuid,${scope.sandboxGroupId}::uuid,${scope.leaseId}::uuid,
        ${scope.createOperationId},${scope.sandboxId}) as admission`);
    const result = z
      .object({
        qualification: Qualification,
        plan: NativeBrokerCreatePlan,
        providerBindingKey: QualificationBase.shape.providerBindingKey,
        createEpoch: z.number().int().nonnegative().safe(),
        phase: z.enum(["warming", "warm"]),
      })
      .strict()
      .parse(row?.admission);
    const plan = validateQualifiedNativeBrokerPlan(result.qualification, result.plan);
    if (
      !plan ||
      result.qualification.sourceSha !== scope.sourceSha ||
      result.qualification.providerBindingKey !== scope.providerBindingKey ||
      result.providerBindingKey !== scope.providerBindingKey
    )
      throw new Error("Native broker bootstrap host source or provider namespace is unqualified");
    return Object.freeze({
      phase: result.phase,
      binding: Object.freeze({
        version: 1 as const,
        ...scope,
        brokerId: plan.brokerId,
        createEpoch: result.createEpoch,
        artifactSha256: plan.artifact.artifactSha256,
      }),
      artifact: Object.freeze({ ...plan.artifact }),
    });
  });
}

/** Data validation only. The trusted provider caller obtains the plan from
 * the original physical intent, never from public metadata. SQL repeats this
 * binding and preserves the original immutable enrollment on every update. */
export function validateQualifiedNativeBrokerPlan(
  qualification: NativeCommandBirthQualification | null,
  input: unknown,
): NativeBrokerCreatePlan | undefined {
  if (!qualification?.brokerArtifact) {
    if (input !== undefined)
      throw new Error("Native broker creation requires a broker-qualified group birth");
    return undefined;
  }
  const plan = NativeBrokerCreatePlan.parse(input);
  const artifact = qualification.brokerArtifact;
  if (
    plan.sourceSha !== qualification.sourceSha ||
    plan.imageId !== qualification.providerImageId ||
    plan.artifact.artifactSha256 !== artifact.artifactSha256 ||
    plan.artifact.byteSize !== artifact.byteSize ||
    plan.artifact.target !== artifact.target
  )
    throw new Error("Native broker create plan differs from its exact qualification");
  return plan;
}

/** Operator-only: its DB handle must own the private ledger. Runtime roles
 * cannot publish or enable qualification, regardless of supplied scope IDs.
 * The reviewed native acceptance evidence is operator input, never generated
 * from a version string or current provider capability probe. */
export async function publishNativeCommandQualification(
  db: Database,
  input: NativeCommandQualification,
): Promise<void> {
  const qualification = Qualification.parse(input);
  if (typeof input.enrollmentEnabled !== "boolean")
    throw new Error("Qualification enrollment decision is required");
  await withRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await assertNativeCommandQualificationReady(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      'native-command-qualification:' || current_schema() || ':' || ${input.workspaceId}::text, 0))`);
      const [workspace] = await tx.execute<{ id: string }>(sql`select id from workspaces
      where id = ${input.workspaceId}::uuid and account_id = ${input.accountId}::uuid`);
      if (!workspace)
        throw new Error("Qualification workspace does not belong to its owner-selected account");
      if (input.enrollmentEnabled)
        await tx.execute(sql`update opengeni_private.native_command_qualifications
      set enrollment_enabled = false where data_schema = current_schema() and workspace_id = ${input.workspaceId}::uuid and enrollment_enabled`);
      await tx.execute(sql`insert into opengeni_private.native_command_qualifications
      (data_schema,id,account_id,workspace_id,creator_kind,creator_subject_id,create_idempotency_key,activation_generation,source_sha,image_ref,provider_image_id,provider_binding_key,protocols,acceptance_evidence_hash,enrollment_enabled,broker_artifact)
      values (current_schema(),${qualification.id}::uuid,${qualification.accountId}::uuid,${qualification.workspaceId}::uuid,
        'subject',${qualification.creatorSubjectId},${qualification.createIdempotencyKey},
        ${qualification.activationGeneration},${qualification.sourceSha},${qualification.imageRef},${qualification.providerImageId},${qualification.providerBindingKey},
        ARRAY[${qualification.protocols[0]},${qualification.protocols[1]}]::text[],${qualification.acceptanceEvidenceHash},${input.enrollmentEnabled},
        ${qualification.brokerArtifact ? JSON.stringify(qualification.brokerArtifact) : null}::jsonb)`);
    }),
  );
}

/** Disabling admits no new groups. Frozen births, physical bindings and
 * supervised command reconciliation remain authoritative. */
export async function disableNativeCommandEnrollment(
  db: Database,
  input: { accountId: string; workspaceId: string; qualificationId: string },
): Promise<void> {
  await withRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await assertNativeCommandQualificationReady(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      'native-command-qualification:' || current_schema() || ':' || ${input.workspaceId}::text, 0))`);
      const rows = await tx.execute<{
        id: string;
      }>(sql`update opengeni_private.native_command_qualifications set enrollment_enabled = false
      where data_schema = current_schema() and account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid and id = ${input.qualificationId}::uuid returning id`);
      if (rows.length !== 1)
        throw new Error("Native command qualification disable target does not exist");
    }),
  );
}

export async function loadNativeCommandBirthQualification(
  db: Database,
  scope: NativeCommandQualificationScope,
): Promise<NativeCommandBirthQualification | null> {
  return withRlsContext(db, scope, async (tx) => {
    await assertNativeCommandQualificationReady(tx);
    const [row] = await tx.execute<{
      qualification: unknown;
    }>(sql`select native_command_birth_qualification(
      ${scope.accountId}::uuid,${scope.workspaceId}::uuid,${scope.sandboxGroupId}::uuid) as qualification`);
    return row?.qualification == null ? null : Qualification.parse(row.qualification);
  });
}

/** Scope is derived by the trusted original route/lease admission. Never
 * accept sourceSha from request metadata or deployment telemetry: it must be
 * the immutable built candidate source identity tested by the operator. */
async function loadNativeCommandProviderDecision(
  db: Database,
  input: NativeCommandQualificationScope & {
    providerInstanceId: string;
    leaseEpoch: number;
    sourceSha: string;
  },
): Promise<LoadedNativeCommandProviderDecision> {
  return withRlsContext(db, input, async (tx) => {
    await assertNativeCommandQualificationReady(tx);
    const [row] = await tx.execute<{
      decision: unknown;
    }>(sql`select native_command_provider_qualification(
      ${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sandboxGroupId}::uuid,
      ${input.providerInstanceId},${input.leaseEpoch}) as decision`);
    const decision = z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("legacy") }),
        z.object({ status: z.literal("enrolled"), qualification: Qualification }),
        z.object({
          status: z.literal("blocked"),
          reason: z.string(),
          qualification: Qualification,
        }),
      ])
      .parse(row?.decision);
    if (decision.status === "legacy") return decision;
    if (decision.qualification.sourceSha !== input.sourceSha)
      return {
        status: "blocked",
        reason: "source_identity_unqualified",
        qualification: decision.qualification,
      };
    return decision;
  });
}

/** Exact-protocol inspection is deliberately distinct from selecting a
 * transport for a command shape. Retained callers may not reinterpret their
 * original protocol merely because a newer artifact is available. */
export async function inspectNativeCommandProviderQualification(
  db: Database,
  input: NativeCommandQualificationScope & {
    providerInstanceId: string;
    leaseEpoch: number;
    protocol: CommandSupervisionProtocol | NativeBrokerCommandProtocol;
    sourceSha: string;
  },
): Promise<NativeCommandProviderQualification> {
  const decision = await loadNativeCommandProviderDecision(db, input);
  if (
    decision.status === "legacy" ||
    (decision.status === "blocked" && decision.reason === "source_identity_unqualified")
  )
    return decision;
  if (!decision.qualification.protocols.some((protocol) => protocol === input.protocol))
    return {
      status: "blocked",
      reason: "protocol_unqualified",
      qualification: decision.qualification,
    };
  return decision;
}

/** Select from the original frozen birth and exact live physical enrollment,
 * not adapter capabilities, current deployment defaults or error fallback.
 * The requested legacy name expresses pipe/PTY shape only; it grants no new
 * qualification and cannot change an existing retained command's protocol. */
export async function selectNativeCommandProviderProtocol(
  db: Database,
  input: NativeCommandQualificationScope & {
    providerInstanceId: string;
    leaseEpoch: number;
    protocol: CommandSupervisionProtocol;
    sourceSha: string;
  },
): Promise<
  | Exclude<NativeCommandProviderQualification, { status: "enrolled" }>
  | {
      status: "enrolled";
      qualification: NativeCommandBirthQualification;
      protocol: CommandSupervisionProtocol | NativeBrokerCommandProtocol;
    }
> {
  const requested = CommandSupervisionProtocol.parse(input.protocol);
  const decision = await loadNativeCommandProviderDecision(db, input);
  if (decision.status !== "enrolled") return decision;
  return {
    ...decision,
    protocol: decision.qualification.protocols[requested === "native-subreaper-pty-v1" ? 1 : 0],
  };
}
