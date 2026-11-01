import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { secretValue } from "./secret-value";
import { z } from "zod";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11): an
 * organization owner or admin adds an MCP connector once and chooses which
 * workspaces it reaches. A workspace's own setup of the same connector, on or
 * off, wins there.
 *
 * How turns sign in:
 * - `each_person`: nothing is shared. Each person connects their own account,
 *   which works where they turned it on.
 * - `organization_key`: request headers (such as an API key) stored encrypted
 *   on the organization's setup, never returned, and sent only to that server.
 *   Every turn in a reached workspace uses them.
 * - `none`: a server that needs no sign-in.
 */
export const OrganizationConnectorLogin = /* @__PURE__ */ defineSchema(() =>
  z.enum(["each_person", "organization_key", "none"]),
);
export type OrganizationConnectorLogin = z.infer<typeof OrganizationConnectorLogin>;

/** Where it works: the same reach as the organization's vaults and model keys. */
export const OrganizationConnectorAvailability = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The shared workspaces it reaches, or null for every one, including new ones. */
      allowedWorkspaceIds: z.array(primitives.uuid).max(500).nullable(),
      /** Whether members can use it in their own Personal workspace. */
      allowPersonalWorkspaces: primitives.boolean,
    })
    .strict(),
);
export type OrganizationConnectorAvailability = z.infer<typeof OrganizationConnectorAvailability>;

const toolNames = /* @__PURE__ */ defineSchema(() =>
  z
    .array(primitives.string.trim().min(1).max(200))
    .max(500)
    .refine((values) => new Set(values).size === values.length, "Duplicate tool names"),
);

export const OrganizationConnector = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    /** The capability id workspaces see it under (a catalog id, or the custom server's own). */
    capabilityId: primitives.string,
    name: primitives.string,
    description: primitives.nullableString,
    endpointUrl: primitives.string,
    /** A connector from the catalog, or a custom server URL the organization added. */
    source: z.enum(["catalog", "custom"]),
    login: OrganizationConnectorLogin,
    /** `organization_key` only: the names of the stored headers. Values are never returned. */
    headerNames: z.array(primitives.string),
    /** The tools on everywhere it reaches, or null for every tool the server lists. */
    allowedTools: z.array(primitives.string).nullable(),
    availability: OrganizationConnectorAvailability,
    status: z.enum(["active", "disabled"]),
    /** False when its catalog entry was retired: no workspace serves it until it returns. */
    available: primitives.boolean,
    generation: primitives.positiveInteger,
    createdAt: primitives.string,
    updatedAt: primitives.string,
  }),
);
export type OrganizationConnector = z.infer<typeof OrganizationConnector>;

export const ListOrganizationConnectorsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ connectors: z.array(OrganizationConnector) }),
);
export type ListOrganizationConnectorsResponse = z.infer<typeof ListOrganizationConnectorsResponse>;

export const OrganizationConnectorCustomServer = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(120),
      description: primitives.string.trim().max(500).nullable().optional(),
      /** A remote streamable HTTP MCP endpoint. */
      endpointUrl: primitives.string.trim().url().max(2048),
    })
    .strict(),
);
export type OrganizationConnectorCustomServer = z.infer<typeof OrganizationConnectorCustomServer>;

export const CreateOrganizationConnectorRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** A catalog connector's id. Give this or `custom`, not both. */
      capabilityId: primitives.string.trim().min(1).max(300).optional(),
      custom: OrganizationConnectorCustomServer.optional(),
      login: OrganizationConnectorLogin,
      /** `organization_key` only: the request headers to send, such as an Authorization header. */
      headers: secretValue(z.record(primitives.string, primitives.string)).optional(),
      allowedTools: toolNames.nullable().optional(),
      availability: OrganizationConnectorAvailability,
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.capabilityId === undefined) === (value.custom === undefined))
        context.addIssue({
          code: "custom",
          message: "Give either a catalog capabilityId or a custom server",
          path: ["capabilityId"],
        });
      const headerCount = Object.keys(value.headers ?? {}).length;
      if (value.login === "organization_key" && headerCount === 0)
        context.addIssue({
          code: "custom",
          message: "An organization key needs at least one header",
          path: ["headers"],
        });
      if (value.login !== "organization_key" && headerCount > 0)
        context.addIssue({
          code: "custom",
          message: "Headers are only for an organization key",
          path: ["headers"],
        });
    }),
);
export type CreateOrganizationConnectorRequest = z.infer<typeof CreateOrganizationConnectorRequest>;

export const UpdateOrganizationConnectorRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The generation the change was made from; a newer one is refused (409). */
      expectedGeneration: primitives.positiveInteger,
      availability: OrganizationConnectorAvailability.optional(),
      allowedTools: toolNames.nullable().optional(),
      status: z.enum(["active", "disabled"]).optional(),
      /** `organization_key` only: replaces every stored header; the server is checked again. */
      headers: secretValue(z.record(primitives.string, primitives.string)).optional(),
    })
    .strict(),
);
export type UpdateOrganizationConnectorRequest = z.infer<typeof UpdateOrganizationConnectorRequest>;
