import { z } from "zod";

export const ModelConnectionAccessPolicy = z
  .object({
    allowedModels: z.array(z.string().trim().min(1).max(256)).max(500).nullable(),
    /**
     * Organization-pool grants: the shared workspaces that may use the account,
     * or null for every shared workspace, including ones created later. A
     * workspace's own copy (`localWorkspaceIds` in the response) is reported
     * separately and is never cleared by this list.
     */
    allowedWorkspaces: z.array(z.string().uuid()).max(500).nullable(),
    allowPersonalWorkspaces: z.boolean(),
    /**
     * Organization memberships of the chosen people, or null when the account
     * is not limited to people. Non-null requires `allowedWorkspaces: []` and
     * `allowPersonalWorkspaces: false`. Only organization accounts on the shared
     * subscription core support it (`peopleSupported`).
     */
    allowedPeople: z.array(z.string().uuid()).max(1000).nullable().optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const ModelConnectionAccessResponse = z.object({
  policy: ModelConnectionAccessPolicy,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  personalWorkspacesSupported: z.boolean(),
  /**
   * The account can be limited to chosen people (`allowedPeople`): an
   * organization account no workspace manages (people scope would hide it
   * from a managing workspace's administrators).
   */
  peopleSupported: z.boolean().optional(),
  /** The people an administrator can choose: active members of the organization. */
  people: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      }),
    )
    .max(1000)
    .optional(),
  /**
   * Workspaces that use the account as their own (it was connected there).
   * They keep it whatever is chosen for workspaces; choosing people limits
   * them to the chosen people too.
   */
  localWorkspaceIds: z.array(z.string().uuid()).max(500).optional(),
  /** The workspace whose administrators also manage the account, if any. */
  managedByWorkspaceId: z.string().uuid().nullable().optional(),
});
