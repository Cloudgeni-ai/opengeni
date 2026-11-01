import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Where an API integration (OpenAPI or GraphQL) comes from: shared by a
 * workspace's own integrations and an organization's (organization-connectors).
 */
export const ApiIntegrationProtocol = /* @__PURE__ */ defineSchema(() =>
  z.enum(["openapi", "graphql"]),
);
export type ApiIntegrationProtocol = z.infer<typeof ApiIntegrationProtocol>;

/** How an API authenticates, as a preview (and an organization's API integration) describes it. */
export const ApiIntegrationAuthPreview = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("oauth2"),
        providerDomain: z.string().min(1).max(253),
        scopes: z.array(z.string().min(1).max(1024)).max(256),
      })
      .strict(),
    z
      .object({
        kind: z.literal("api_key"),
        providerDomain: z.string().min(1).max(253),
        carrier: z.enum(["header", "query", "cookie"]),
        name: z.string().min(1).max(256),
      })
      .strict(),
    z
      .object({
        kind: z.literal("http"),
        providerDomain: z.string().min(1).max(253),
        scheme: z.string().min(1).max(64),
      })
      .strict(),
  ]),
);
export type ApiIntegrationAuthPreview = z.infer<typeof ApiIntegrationAuthPreview>;

export const IntegrationSource = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("definition"),
        definitionId: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal("openapi"),
        url: z.string().url().max(2048),
        baseUrl: z.string().url().max(2048).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("graphql"),
        endpoint: z.string().url().max(2048),
        name: z.string().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("auto"),
        url: z.string().url().max(2048),
        baseUrl: z.string().url().max(2048).optional(),
      })
      .strict(),
  ]),
);
export type IntegrationSource = z.infer<typeof IntegrationSource>;

/** Custom OpenAPI documents must fit the same 8 MiB bound as fetched specs. */
export const INLINE_OPENAPI_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * An OpenAPI 3.x document supplied in the request body (JSON or YAML text)
 * instead of fetched from a URL. `sourceKey` is the caller's stable identity
 * for the Integration: the same key updates the same installation across
 * document revisions. Server URLs must be absolute (or `baseUrl` given), and
 * every call still goes through the deployment network policy, so a product
 * on a private or loopback address stays unreachable unless the operator
 * enables private targets; a local product still needs a public tunnel.
 */
export const InlineOpenApiDocumentSource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("openapi_document"),
      sourceKey: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      document: primitives.nonEmptyString.refine(
        (value) => new TextEncoder().encode(value).byteLength <= INLINE_OPENAPI_DOCUMENT_MAX_BYTES,
        `OpenAPI document must be at most ${INLINE_OPENAPI_DOCUMENT_MAX_BYTES} bytes`,
      ),
      baseUrl: z.string().url().max(2048).optional(),
    })
    .strict(),
);
export type InlineOpenApiDocumentSource = z.infer<typeof InlineOpenApiDocumentSource>;

/** Preview/install input: every stored source kind plus an inline document. */
export const IntegrationSourceInput = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [...IntegrationSource.options, InlineOpenApiDocumentSource]),
);
export type IntegrationSourceInput = z.infer<typeof IntegrationSourceInput>;
