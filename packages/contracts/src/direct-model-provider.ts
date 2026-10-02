import { z } from "zod";

export const DirectModelProvider = z.enum(["openai", "azure_openai"]);
export type DirectModelProvider = z.infer<typeof DirectModelProvider>;

/** Pin customer credentials to official provider origins, never arbitrary URLs. */
export const AzureOpenAIEndpoint = z
  .string()
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
      ctx.addIssue({ code: "custom", message: "Enter your Azure OpenAI HTTPS resource endpoint" });
    }
  })
  .transform((value) => new URL(value).origin + "/openai/v1");

export const DirectModelProviderMetadata = z
  .object({
    provider: DirectModelProvider,
    model: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    endpoint: AzureOpenAIEndpoint.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "azure_openai" && !value.endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Azure OpenAI needs an endpoint",
      });
    }
    if (value.provider === "openai" && value.endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "OpenAI uses its official API endpoint",
      });
    }
  });
export type DirectModelProviderMetadata = z.infer<typeof DirectModelProviderMetadata>;

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
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.endpoint!;
  if (connection.providerDomain.toLowerCase() !== new URL(baseUrl).hostname) return null;
  const providerId = `workspace-${config.provider === "openai" ? "openai" : "azure-openai"}-${connection.id}`;
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
  return /^workspace-(?:openai|azure-openai)-[0-9a-f-]{36}\//.test(modelId);
}
