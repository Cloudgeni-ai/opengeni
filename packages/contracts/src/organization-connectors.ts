import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { secretValue } from "./secret-value";
import { z } from "zod";
import {
  ApiIntegrationAuthPreview,
  ApiIntegrationProtocol,
  IntegrationSourceInput,
} from "./integration-sources";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11): an
 * organization owner or admin adds a connector once and chooses which
 * workspaces it reaches. A workspace's own setup of the same connector, on or
 * off, wins there. A connector is a remote MCP server (`kind: "mcp"`) or an
 * API integration (`kind: "api"`): a curated definition, or a custom OpenAPI
 * or GraphQL API, reviewed once and run in every workspace it reaches.
 *
 * How turns sign in:
 * - `each_person`: nothing is shared. Each person connects their own account,
 *   which works where they turned it on.
 * - `organization_key`: request headers (such as an API key) stored encrypted
 *   on the organization's setup, never returned, and sent only to that server.
 *   Every turn in a reached workspace uses them. An API integration's key can
 *   also go in a query parameter or cookie, as its API defines.
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

export const OrganizationConnectorKind = /* @__PURE__ */ defineSchema(() => z.enum(["mcp", "api"]));
export type OrganizationConnectorKind = z.infer<typeof OrganizationConnectorKind>;

/** `kind: "api"` only: the definition the organization reviewed and every reached workspace runs. */
export const OrganizationApiIntegrationSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    definitionId: primitives.string,
    protocol: ApiIntegrationProtocol,
    providerDomain: primitives.string,
    /** How the API itself authenticates, and so what each person or the organization key provides. */
    auth: ApiIntegrationAuthPreview,
    revisionId: primitives.string,
    contentSha256: primitives.string,
    tools: z.array(
      z.object({
        id: primitives.string,
        name: primitives.string,
        safety: z.enum(["read", "write", "destructive"]),
      }),
    ),
  }),
);
export type OrganizationApiIntegrationSummary = z.infer<typeof OrganizationApiIntegrationSummary>;

export const OrganizationConnector = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    kind: OrganizationConnectorKind,
    /** The capability id workspaces see it under (a catalog id, or the custom server's own). */
    capabilityId: primitives.string,
    name: primitives.string,
    description: primitives.nullableString,
    endpointUrl: primitives.string,
    /** A connector from the catalog, or a custom server URL the organization added. */
    source: z.enum(["catalog", "custom"]),
    login: OrganizationConnectorLogin,
    /**
     * `organization_key` only: the names the key is sent under (headers, or an
     * API's header, query or cookie names). Values are never returned.
     */
    headerNames: z.array(primitives.string),
    /** The tools on everywhere it reaches, or null for every tool the server lists. */
    allowedTools: z.array(primitives.string).nullable(),
    availability: OrganizationConnectorAvailability,
    status: z.enum(["active", "disabled"]),
    /** False when its catalog entry was retired: no workspace serves it until it returns. */
    available: primitives.boolean,
    /** `kind: "api"` only. */
    apiIntegration: OrganizationApiIntegrationSummary.nullable(),
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

/**
 * An API integration to add: the same source a workspace previews and
 * installs, with the revision the admin reviewed. Adding it compiles the
 * source again and is refused (409) when it changed since the preview.
 */
export const OrganizationApiIntegrationSource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: IntegrationSourceInput,
      expectedRevisionId: z.string().min(1).max(96),
      expectedContentSha256: primitives.string.regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
);
export type OrganizationApiIntegrationSource = z.infer<typeof OrganizationApiIntegrationSource>;

/** Where an API integration's organization key goes, as the API's authentication defines. */
export const OrganizationApiKeyPlacement = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      carrier: z.enum(["header", "query", "cookie"]),
      name: primitives.string.trim().min(1).max(256),
      value: primitives.string.min(1).max(8192),
      /** Sent before the value, such as "Bearer ". */
      prefix: primitives.string.max(64).optional(),
    })
    .strict(),
);
export type OrganizationApiKeyPlacement = z.infer<typeof OrganizationApiKeyPlacement>;

const apiKeyPlacements = /* @__PURE__ */ defineSchema(() =>
  secretValue(z.array(OrganizationApiKeyPlacement).min(1).max(8)),
);

/** Preview an API integration for the organization, before adding it. */
export const PreviewOrganizationApiIntegrationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: IntegrationSourceInput,
      /** Used only to read an API that needs a key even to describe itself; never stored. */
      apiKey: apiKeyPlacements.optional(),
    })
    .strict(),
);
export type PreviewOrganizationApiIntegrationRequest = z.infer<
  typeof PreviewOrganizationApiIntegrationRequest
>;

/**
 * Turn an organization API integration off in one workspace, or back on. Off
 * is a setting of the workspace's own, which wins over the organization's
 * reach; on removes it.
 */
export const SetOrganizationApiIntegrationHereRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ enabledHere: primitives.boolean }).strict(),
);
export type SetOrganizationApiIntegrationHereRequest = z.infer<
  typeof SetOrganizationApiIntegrationHereRequest
>;

export const OrganizationApiIntegrationHere = /* @__PURE__ */ defineSchema(() =>
  z.object({ capabilityId: primitives.string, enabledHere: primitives.boolean }).strict(),
);
export type OrganizationApiIntegrationHere = z.infer<typeof OrganizationApiIntegrationHere>;

export const CreateOrganizationConnectorRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** A catalog connector's id. Give exactly one of this, `custom` and `apiIntegration`. */
      capabilityId: primitives.string.trim().min(1).max(300).optional(),
      custom: OrganizationConnectorCustomServer.optional(),
      /** An API integration (OpenAPI or GraphQL), previewed first. */
      apiIntegration: OrganizationApiIntegrationSource.optional(),
      login: OrganizationConnectorLogin,
      /** MCP `organization_key` only: the request headers to send, such as an Authorization header. */
      headers: secretValue(z.record(primitives.string, primitives.string)).optional(),
      /** API integration `organization_key` only: the key and where the API expects it. */
      apiKey: apiKeyPlacements.optional(),
      allowedTools: toolNames.nullable().optional(),
      availability: OrganizationConnectorAvailability,
    })
    .strict()
    .superRefine((value, context) => {
      const sources = [value.capabilityId, value.custom, value.apiIntegration].filter(
        (source) => source !== undefined,
      ).length;
      if (sources !== 1)
        context.addIssue({
          code: "custom",
          message:
            "Give exactly one of a catalog capabilityId, a custom server or an API integration",
          path: ["capabilityId"],
        });
      if (value.apiIntegration) {
        if (value.headers !== undefined)
          context.addIssue({
            code: "custom",
            message: "An API integration's key goes in apiKey, not headers",
            path: ["headers"],
          });
        if (value.login === "organization_key" && !value.apiKey)
          context.addIssue({
            code: "custom",
            message: "An organization key needs the key",
            path: ["apiKey"],
          });
        if (value.login !== "organization_key" && value.apiKey)
          context.addIssue({
            code: "custom",
            message: "A key is only for an organization key",
            path: ["apiKey"],
          });
        return;
      }
      if (value.apiKey !== undefined)
        context.addIssue({
          code: "custom",
          message: "apiKey is only for an API integration",
          path: ["apiKey"],
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
      /** MCP `organization_key` only: replaces every stored header; the server is checked again. */
      headers: secretValue(z.record(primitives.string, primitives.string)).optional(),
      /** API integration `organization_key` only: replaces the stored key. */
      apiKey: apiKeyPlacements.optional(),
    })
    .strict(),
);
export type UpdateOrganizationConnectorRequest = z.infer<typeof UpdateOrganizationConnectorRequest>;
