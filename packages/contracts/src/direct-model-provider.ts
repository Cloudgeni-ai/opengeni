import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const DirectModelProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(["openai", "azure_openai", "openai_compatible"]),
);
export type DirectModelProvider = z.infer<typeof DirectModelProvider>;

/** Which OpenAI-compatible API a workspace's own endpoint serves. */
export const CompatibleModelApi = /* @__PURE__ */ defineSchema(() => z.enum(["chat", "responses"]));
export type CompatibleModelApi = z.infer<typeof CompatibleModelApi>;

const COMPATIBLE_OPERATION_SUFFIX = /\/(?:chat\/completions|responses|completions|models)$/i;

/**
 * The HTTPS base URL of a workspace's own OpenAI-compatible API, such as
 * `https://api.example.com/v1`. Only its shape is checked here; every request
 * to it is DNS-pinned to public addresses and refuses redirects at call time.
 * A pasted operation path (`/chat/completions`, `/responses`) is trimmed off.
 */
export const CompatibleModelBaseUrl = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .max(512)
    .url()
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        // The preceding URL validator supplies the normal validation issue.
        return;
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !hostname.includes(".") ||
        /^[\d.]+$/.test(hostname) ||
        hostname.includes(":") ||
        /\.(?:localhost|local|internal)$/i.test(hostname)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Enter your API’s public HTTPS base URL, like https://api.example.com/v1",
        });
      }
    })
    .transform((value) => {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, "").replace(COMPATIBLE_OPERATION_SUFFIX, "");
      return url.origin + path.replace(/\/+$/, "");
    }),
);

/** Pin customer credentials to official provider origins, never arbitrary URLs. */
export const AzureOpenAIEndpoint = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .url()
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        // The preceding URL validator supplies the normal validation issue.
        return;
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname) ||
        !["", "/", "/openai/v1", "/openai/v1/"].includes(url.pathname) ||
        url.search ||
        url.hash
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Enter your Azure OpenAI HTTPS resource endpoint",
        });
      }
    })
    .transform((value) => new URL(value).origin + "/openai/v1"),
);

/** An exact OpenAI model or Azure OpenAI deployment name. */
export const DirectModelName = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/**
 * A model ID exactly as an OpenAI-compatible API lists it under `/models`,
 * which can include an organization prefix or tag (`org/model:tag`).
 */
export const CompatibleModelName = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/),
);

export const DirectModelProviderMetadata = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      provider: DirectModelProvider,
      model: CompatibleModelName,
      endpoint: AzureOpenAIEndpoint.optional(),
      baseUrl: CompatibleModelBaseUrl.optional(),
      api: CompatibleModelApi.optional(),
      label: primitives.string.trim().min(1).max(60).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.provider !== "openai_compatible") {
        if (!DirectModelName.safeParse(value.model).success) {
          ctx.addIssue({
            code: "custom",
            path: ["model"],
            message: "Enter the exact model or deployment name",
          });
        }
        for (const field of ["baseUrl", "api", "label"] as const) {
          if (value[field] !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: "Only an OpenAI-compatible endpoint sets this",
            });
          }
        }
      }
      if (value.provider === "azure_openai" && !value.endpoint) {
        ctx.addIssue({
          code: "custom",
          path: ["endpoint"],
          message: "Azure OpenAI needs an endpoint",
        });
      }
      if (value.provider !== "azure_openai" && value.endpoint) {
        ctx.addIssue({
          code: "custom",
          path: ["endpoint"],
          message:
            value.provider === "openai"
              ? "OpenAI uses its official API endpoint"
              : "An OpenAI-compatible endpoint uses baseUrl",
        });
      }
      if (value.provider === "openai_compatible" && !value.baseUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "An OpenAI-compatible endpoint needs its base URL",
        });
      }
    }),
);
export type DirectModelProviderMetadata = z.infer<typeof DirectModelProviderMetadata>;

/** The API origin a direct model connection sends its key to. */
export function directModelBaseUrl(config: DirectModelProviderMetadata): string {
  return config.provider === "openai"
    ? "https://api.openai.com/v1"
    : config.provider === "azure_openai"
      ? config.endpoint!
      : config.baseUrl!;
}

const DIRECT_MODEL_PROVIDER_ID_PREFIXES = {
  openai: "workspace-openai-",
  azure_openai: "workspace-azure-openai-",
  openai_compatible: "workspace-compatible-",
} as const satisfies Record<DirectModelProvider, string>;

/** Whether a provider id names a workspace's own direct model connection. */
export function isDirectModelProviderId(providerId: string | null | undefined): boolean {
  return (
    typeof providerId === "string" &&
    Object.values(DIRECT_MODEL_PROVIDER_ID_PREFIXES).some((prefix) => providerId.startsWith(prefix))
  );
}

/** The direct model provider a workspace provider id belongs to, if any. */
export function directModelProviderOfProviderId(
  providerId: string | null | undefined,
): DirectModelProvider | null {
  if (typeof providerId !== "string") return null;
  for (const [provider, prefix] of Object.entries(DIRECT_MODEL_PROVIDER_ID_PREFIXES)) {
    if (providerId.startsWith(prefix)) return provider as DirectModelProvider;
  }
  return null;
}

export function directModelConnectionSpec(connection: {
  id: string;
  version: number;
  subjectId: string | null;
  kind: string;
  status: string;
  providerDomain: string;
  metadata: Record<string, unknown>;
}) {
  if (
    connection.subjectId !== null ||
    connection.kind !== "api_key" ||
    connection.status !== "active"
  )
    return null;
  const parsed = DirectModelProviderMetadata.safeParse(connection.metadata.directModelProvider);
  if (!parsed.success || connection.metadata.credentialRole !== `direct_${parsed.data.provider}`)
    return null;
  const config = parsed.data;
  const baseUrl = directModelBaseUrl(config);
  if (connection.providerDomain.toLowerCase() !== new URL(baseUrl).hostname) return null;
  const providerId = `${DIRECT_MODEL_PROVIDER_ID_PREFIXES[config.provider]}${connection.id}`;
  return {
    ...config,
    baseUrl,
    providerId,
    modelId: `${providerId}/${connection.version}/${config.model}`,
    connectionId: connection.id,
    version: connection.version,
  };
}

export function isDirectModelId(modelId: string): boolean {
  return /^workspace-(?:openai|azure-openai|compatible)-[0-9a-f-]{36}\//.test(modelId);
}
