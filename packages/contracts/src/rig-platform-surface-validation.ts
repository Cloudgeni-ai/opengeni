import { z } from "zod";

export const RigPlatformSurfaceValidationBinding = z
  .object({
    leaseId: z.string().uuid(),
    sandboxGroupId: z.string().uuid(),
    leaseEpoch: z.number().int().positive(),
    workspaceGeneration: z.number().int().nonnegative(),
    instanceId: z.string().min(1).max(512),
    backendId: z.string().min(1).max(128),
    rigVersionId: z.string().uuid(),
  })
  .strict();
export type RigPlatformSurfaceValidationBinding = z.infer<
  typeof RigPlatformSurfaceValidationBinding
>;

export const RigPlatformSurfaceValidationReceipt = z
  .object({
    version: z.literal(1),
    checkedAt: z.string().datetime(),
    binding: RigPlatformSurfaceValidationBinding,
    terminal: z.discriminatedUnion("status", [
      z.object({ status: z.literal("disabled") }).strict(),
      z
        .object({
          status: z.literal("passed"),
          cwd: z.literal("/workspace"),
          uid: z.literal(0),
          bunVersion: z.literal("1.4.0"),
          interactive: z.literal(true),
        })
        .strict(),
    ]),
    browser: z
      .object({
        status: z.literal("passed"),
        browserSessionId: z.string().uuid(),
        controllerGeneration: z.string().min(1).max(256),
        targetId: z.string().min(1).max(512),
        observedTargetGeneration: z.string().min(1).max(256),
      })
      .strict(),
    computer: z.discriminatedUnion("status", [
      z.object({ status: z.literal("disabled") }).strict(),
      z
        .object({
          status: z.literal("passed"),
          computerSessionId: z.string().uuid(),
          controllerGeneration: z.string().min(1).max(256),
          targetId: z.string().min(1).max(512),
          targetGeneration: z.string().min(1).max(256),
          frameId: z.string().min(1).max(256),
          image: z
            .object({
              mediaType: z.enum(["image/jpeg", "image/png"]),
              sizeBytes: z
                .number()
                .int()
                .positive()
                .max(32 * 1024 * 1024),
              width: z.number().int().positive().max(4096),
              height: z.number().int().positive().max(4096),
              sha256: z.string().regex(/^[0-9a-f]{64}$/u),
            })
            .strict(),
          actionOperationId: z.string().uuid(),
        })
        .strict(),
    ]),
  })
  .strict();
export type RigPlatformSurfaceValidationReceipt = z.infer<
  typeof RigPlatformSurfaceValidationReceipt
>;

/** Server trust-boundary projection for a change whose platform receipt may be
 * used for promotion. The public RigChange verification bag stays open-ended;
 * promotion code must parse this strict projection before trusting the receipt. */
export const RigChangePlatformSurfaceValidationTarget = z
  .object({
    id: z.string().uuid(),
    baseVersionId: z.string().uuid(),
    verification: z
      .object({
        passed: z.literal(true),
        platformSurfaceValidation: RigPlatformSurfaceValidationReceipt,
      })
      .passthrough(),
  })
  .passthrough();
export type RigChangePlatformSurfaceValidationTarget = z.infer<
  typeof RigChangePlatformSurfaceValidationTarget
>;
