import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ModelConnectionAccessPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      allowedModels: z.array(primitives.string.trim().min(1).max(256)).max(500).nullable(),
      /**
       * Organization-pool grants: the shared workspaces that may use the account,
       * or null for every shared workspace, including ones created later. A
       * workspace's own copy (`localWorkspaceIds` in the response) is reported
       * separately and is never cleared by this list.
       */
      allowedWorkspaces: z.array(primitives.uuid).max(500).nullable(),
      allowPersonalWorkspaces: primitives.boolean,
      /**
       * Organization memberships of the chosen people, or null when the account
       * is not limited to people. Non-null requires `allowedWorkspaces: []` and
       * `allowPersonalWorkspaces: false`. Only organization accounts on the shared
       * subscription core support it (`peopleSupported`).
       */
      allowedPeople: z.array(primitives.uuid).max(1000).nullable().optional(),
      /** Explicit owner consent to convert a personal subscription into a shared account. */
      sharePersonal: z.literal(true).optional(),
      version: primitives.positiveInteger,
    })
    .strict(),
);

export const ModelConnectionAccessResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    policy: ModelConnectionAccessPolicy,
    models: z.array(z.object({ id: primitives.string, label: primitives.string })),
    workspaces: z.array(z.object({ id: primitives.uuid, name: primitives.string })),
    personalWorkspacesSupported: primitives.boolean,
    /**
     * The account can be limited to chosen people (`allowedPeople`): an
     * organization account no workspace manages (people scope would hide it
     * from a managing workspace's administrators).
     */
    peopleSupported: primitives.optionalBoolean,
    /** The people an administrator can choose: active members of the organization. */
    people: z
      .array(
        z.object({
          id: primitives.uuid,
          name: primitives.nullableString,
          email: primitives.nullableString,
        }),
      )
      .max(1000)
      .optional(),
    /**
     * Workspaces that use the account as their own (it was connected there).
     * They keep it whatever is chosen for workspaces; choosing people limits
     * them to the chosen people too.
     */
    localWorkspaceIds: z.array(primitives.uuid).max(500).optional(),
    /** The workspace whose administrators also manage the account, if any. */
    managedByWorkspaceId: z.string().uuid().nullable().optional(),
    /** Exact personal owner is also an organization administrator; sharing requires explicit consent. */
    personalSharingSupported: primitives.optionalBoolean,
  }),
);
