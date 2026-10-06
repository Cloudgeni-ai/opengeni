import { z } from "zod";

const text = z.string().refine((value) => !value.includes("\0"));
const identity = text.min(1).max(512);
const count = z.number().int().nonnegative().safe();
/** Nonsecret request identity for one immutable host credential generation.
 * Renewal must use a new identity; recovery never refreshes this definition. */
export const SandboxV2CredentialGenerationDefinition = z
  .object({
    generationId: identity,
    purpose: z.enum(["provision", "renewal"]),
    forceRefresh: z.boolean(),
  })
  .strict();
export type SandboxV2CredentialGenerationDefinition = z.infer<
  typeof SandboxV2CredentialGenerationDefinition
>;

/** Nonsecret, ordered activation identity. One pending ticket survives worker
 * loss; neither a timer nor a replacement observer may replace it. */
export const SandboxV2CredentialTicket = z
  .object({
    ordinal: count,
    definition: SandboxV2CredentialGenerationDefinition,
    writerActionId: z.string().regex(/^sandbox-v2:[a-f0-9]{64}$/u),
  })
  .strict();
export type SandboxV2CredentialTicket = z.infer<typeof SandboxV2CredentialTicket>;

/** Original broker/remote-target selection, never material or callback secrets.
 * The request digest binds the complete ordinary frozen turn request without
 * putting arbitrary initiator context into a preparation manifest. */
export const SandboxV2CredentialProviderSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("host"), identity }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z
    .object({ kind: z.literal("organization"), id: z.string().uuid(), enabled: z.boolean() })
    .strict(),
]);
export type SandboxV2CredentialProviderSelection = z.infer<
  typeof SandboxV2CredentialProviderSelection
>;
export const SandboxV2CredentialSelection = z
  .object({
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    provider: SandboxV2CredentialProviderSelection,
    variableSet: z
      .object({ id: z.string().uuid(), name: text.min(1).max(512) })
      .strict()
      .nullable(),
    mcpServers: z
      .array(
        z
          .object({
            id: identity,
            // Target URLs can contain credential query parameters. Bind the
            // selected original without retaining its plaintext in the plan.
            urlDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(512),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.mcpServers.map((server) => server.id)).size === value.mcpServers.length,
  );
export type SandboxV2CredentialSelection = z.infer<typeof SandboxV2CredentialSelection>;

export const SandboxV2PreparationFile = z
  .object({
    fileId: identity,
    mountPath: text.min(1).max(2048),
    filename: text.min(1).max(1024),
    sizeBytes: count,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type SandboxV2PreparationFile = z.infer<typeof SandboxV2PreparationFile>;

/** Bounded full-repository preparation. Credentials remain in the original
 * generation; URLs containing credentials and optional/subpath imports are not
 * part of this contract. */
export const SandboxV2PreparationRepository = z
  .object({
    uri: text
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.href === value &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    ref: text
      .min(1)
      .max(2048)
      .refine((value) => !value.startsWith("-") && !/[\s\x7f]/u.test(value)),
    mountPath: text
      .min(1)
      .max(2048)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          value.split("/").every((part) => part && part !== "." && part !== ".."),
      ),
    expectedCommitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
  })
  .strict();
export type SandboxV2PreparationRepository = z.infer<typeof SandboxV2PreparationRepository>;

/** Trusted host plan, retained before preparation begins. Credential material,
 * signed URLs and stdin bytes stay in their original host-owned generation;
 * this record contains only stable references and nonsecret setup commands. */
export const SandboxV2PreparationPlan = z
  .object({
    setupId: identity,
    workspaceRoot: text
      .max(2048)
      .refine(
        (value) =>
          value.startsWith("/") &&
          value.split("/").some(Boolean) &&
          value.split("/").every((part) => part !== "." && part !== ".."),
      )
      .optional(),
    credentialGenerationId: identity.optional(),
    credentialSelection: SandboxV2CredentialSelection.optional(),
    repositories: z.array(SandboxV2PreparationRepository).max(256).optional(),
    /** Metadata-only compound workspace definition. It executes no setup and
     * carries no source content, credentials, receipt or completion proof. */
    workspaceOperation: z
      .object({
        operationId: z.string().uuid(),
        requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        sourceSnapshotDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      })
      .strict()
      .optional(),
    steps: z
      .array(
        z
          .object({
            stepId: z.string().regex(/^[a-zA-Z0-9_./:-]{1,128}$/u),
            command: z
              .object({
                cmd: text.max(262144),
                workdir: text.max(2048).optional(),
                shell: text.max(2048).optional(),
                login: z.boolean().optional(),
                tty: z.boolean().optional(),
                yieldTimeMs: count.optional(),
                maxOutputTokens: count.min(1).optional(),
                runAs: text.max(512).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(256),
    files: z.array(SandboxV2PreparationFile).max(1024),
  })
  .strict()
  .refine((plan) => !plan.credentialSelection || Boolean(plan.credentialGenerationId))
  .refine((plan) =>
    plan.workspaceOperation
      ? plan.setupId === `workspace-operation:v1:${plan.workspaceOperation.operationId}` &&
        plan.workspaceRoot !== undefined &&
        !plan.credentialGenerationId &&
        !plan.credentialSelection &&
        !plan.repositories?.length &&
        plan.steps.length === 0 &&
        plan.files.length === 0
      : !plan.setupId.startsWith("workspace-operation:"),
  )
  .refine((plan) => new Set(plan.steps.map((step) => step.stepId)).size === plan.steps.length)
  .refine((plan) => new Set(plan.files.map((file) => file.fileId)).size === plan.files.length)
  .refine(
    (plan) =>
      new Set((plan.repositories ?? []).map((repository) => repository.mountPath)).size ===
      (plan.repositories?.length ?? 0),
  )
  .refine((plan) => new TextEncoder().encode(JSON.stringify(plan)).length <= 1024 * 1024);
type ParsedPlan = z.infer<typeof SandboxV2PreparationPlan>;
export type SandboxV2PreparationPlan = Omit<ParsedPlan, "steps" | "files"> & {
  steps: ReadonlyArray<ParsedPlan["steps"][number]>;
  files: ReadonlyArray<ParsedPlan["files"][number]>;
};
