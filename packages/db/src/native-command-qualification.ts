import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  canonicalModalCheckpointProviderBinding,
  type CommandSupervisionProtocol,
} from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import { assertNativeCommandQualificationReady } from "./native-command-readiness";

const Qualification = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  workspaceId: z.uuid(),
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
  protocols: z.tuple([z.literal("native-subreaper-v1"), z.literal("native-subreaper-pty-v1")]),
  acceptanceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

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
      (data_schema,id,account_id,workspace_id,activation_generation,source_sha,image_ref,provider_image_id,provider_binding_key,protocols,acceptance_evidence_hash,enrollment_enabled)
      values (current_schema(),${qualification.id}::uuid,${qualification.accountId}::uuid,${qualification.workspaceId}::uuid,
        ${qualification.activationGeneration},${qualification.sourceSha},${qualification.imageRef},${qualification.providerImageId},${qualification.providerBindingKey},
        ARRAY['native-subreaper-v1','native-subreaper-pty-v1'],${qualification.acceptanceEvidenceHash},${input.enrollmentEnabled})`);
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
export async function inspectNativeCommandProviderQualification(
  db: Database,
  input: NativeCommandQualificationScope & {
    providerInstanceId: string;
    leaseEpoch: number;
    protocol: CommandSupervisionProtocol;
    sourceSha: string;
  },
): Promise<NativeCommandProviderQualification> {
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
    if (!decision.qualification.protocols.includes(input.protocol))
      return {
        status: "blocked",
        reason: "protocol_unqualified",
        qualification: decision.qualification,
      };
    return decision;
  });
}
