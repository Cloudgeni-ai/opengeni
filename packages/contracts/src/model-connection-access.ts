import { z } from "zod";

export const ModelConnectionAccessPolicy = z
  .object({
    allowedModels: z.array(z.string().trim().min(1).max(256)).max(500).nullable(),
    allowedWorkspaces: z.array(z.string().uuid()).max(500).nullable(),
    allowPersonalWorkspaces: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict();

export const ModelConnectionAccessResponse = z.object({
  policy: ModelConnectionAccessPolicy,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  personalWorkspacesSupported: z.boolean(),
});
