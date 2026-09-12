import { z } from "zod";

/** Stable workspace externalSource, not an end-user identity or permission. */
export const HostMcpResolverSource = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const generation = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const PutHostMcpResolverRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedGeneration: generation,
    url: z.string().min(1).max(2048),
    bearerToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[^\r\n]+$/),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    acknowledgeLegacyRoutingReplacement: z.boolean().default(false),
  })
  .strict();
export type PutHostMcpResolverRequest = z.input<typeof PutHostMcpResolverRequest>;
export const RevokeHostMcpResolverRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedGeneration: generation.refine((value) => value > 0),
  })
  .strict();
export type RevokeHostMcpResolverRequest = z.input<typeof RevokeHostMcpResolverRequest>;
export const HostMcpResolver = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    externalSource: HostMcpResolverSource,
    url: z.string(),
    timeoutMs: z.number().int(),
    generation: z.number().int().positive(),
    status: z.enum(["active", "revoked"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type HostMcpResolver = z.infer<typeof HostMcpResolver>;
