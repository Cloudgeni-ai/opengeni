import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ModelConnectionAccessPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      allowedModels: z.array(primitives.string.trim().min(1).max(256)).max(500).nullable(),
      /**
       * The shared workspaces that may use the account, or null for every
       * shared workspace, including ones created later. A workspace's own
       * account (`managedByWorkspaceId` in the response) always keeps serving
       * its workspace, whatever this list says. On a workspace's own route
       * this is the list of workspaces it serves; that route can add only
       * workspaces the caller also administers.
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
      /**
       * Explicit consent to make a workspace's own account the organization's,
       * so that workspace's administrators no longer manage it. Required on the
       * organization route before a workspace's own account can serve every
       * shared workspace, Personal workspaces or chosen people.
       */
      moveToOrganization: z.literal(true).optional(),
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
