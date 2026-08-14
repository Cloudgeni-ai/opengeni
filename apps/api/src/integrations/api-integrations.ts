import { createHash } from "node:crypto";

import {
  compileGraphqlRevision,
  compileOpenApiRevision,
  discoverOpenApiAuth,
  fetchGraphqlIntrospection,
  fetchIntegrationSourceDocument,
  filterOpenApiDocumentForDefinition,
  googleDiscoveryToOpenApi,
  integrationDefinitionById,
  parseOpenApiDocument,
  type IntegrationCredentialResolver,
  type IntegrationInvocationAuthority,
  type IntegrationTransport,
  type OpenApiAuthDiscovery,
} from "@opengeni/capabilities";
import {
  ApiIntegrationPreview,
  type ApiIntegrationAuthPreview,
  type IntegrationSource,
} from "@opengeni/contracts";
import type { StoredApiIntegrationRevision } from "@opengeni/db";

const MAX_CURATED_DEFINITION_SOURCE_BYTES = 64 * 1024 * 1024;

export type ApiIntegrationConnectionDescriptor = {
  id: string;
  kind: "oauth2" | "api_key" | "app_install" | "delegated";
  providerDomain: string;
  scopes: string[];
  ownership: "workspace" | "personal";
};

export type ResolvedApiIntegrationPreview = {
  preview: ApiIntegrationPreview;
  revision: StoredApiIntegrationRevision;
  provider: string | null;
  requiredScopes: string[];
  authScheme: Record<string, unknown>;
};

export async function resolveApiIntegrationPreview(input: {
  source: IntegrationSource;
  connection: ApiIntegrationConnectionDescriptor | null;
  transport: IntegrationTransport;
  credentialResolver?: IntegrationCredentialResolver;
  authority: IntegrationInvocationAuthority;
}): Promise<ResolvedApiIntegrationPreview> {
  if (input.source.kind === "definition") {
    return await resolveDefinition(input);
  }
  if (input.source.kind === "graphql") {
    return await resolveGraphql(input, input.source.endpoint, input.source.name);
  }
  if (input.source.kind === "openapi") {
    return await resolveOpenApi(input, input.source.url, input.source.baseUrl);
  }
  let openApiFailure: unknown;
  try {
    return await resolveOpenApi(input, input.source.url, input.source.baseUrl);
  } catch (error) {
    openApiFailure = error;
  }
  try {
    return await resolveGraphql(input, input.source.url);
  } catch (graphqlFailure) {
    const detectionFailure = new Error(
      "The URL is neither a supported OpenAPI document nor a GraphQL endpoint",
      { cause: graphqlFailure },
    );
    Object.defineProperty(detectionFailure, "openApiFailure", {
      value: openApiFailure,
      enumerable: false,
    });
    throw detectionFailure;
  }
}

async function resolveDefinition(
  input: Parameters<typeof resolveApiIntegrationPreview>[0],
): Promise<ResolvedApiIntegrationPreview> {
  if (input.source.kind !== "definition") throw new Error("Expected a provider definition source");
  const definition = integrationDefinitionById(input.source.definitionId);
  if (!definition) throw new Error(`Unknown Integration definition: ${input.source.definitionId}`);
  const bytes = await fetchIntegrationSourceDocument(
    input.transport,
    definition.source.url,
    MAX_CURATED_DEFINITION_SOURCE_BYTES,
  );
  let document: Record<string, unknown>;
  if (definition.source.kind === "google_discovery") {
    document = filterOpenApiDocumentForDefinition(
      googleDiscoveryToOpenApi(JSON.parse(new TextDecoder().decode(bytes))),
      definition,
    );
  } else {
    document = filterOpenApiDocumentForDefinition(parseOpenApiDocument(bytes), definition);
  }
  const identity = integrationInstallationIdentity("openapi", definition.id, definition.source.url);
  const revision = compileOpenApiRevision(document, {
    definitionId: definition.id,
    sourceUrl: definition.source.url,
    baseUrl: definition.baseUrl,
    provider: definition.provider.id,
  });
  const baseUrl = firstOpenApiServerUrl(revision);
  const providerDomain = definition.provider.domain;
  const auth: ApiIntegrationAuthPreview = {
    kind: "oauth2",
    providerDomain,
    scopes: [...definition.authentication.scopes],
  };
  return resolvedPreview({
    source: input.source,
    definitionId: definition.id,
    definitionProvenance: "curated",
    identity,
    revision,
    provider: definition.provider.id,
    providerDomain,
    baseUrl,
    sourceUrl: definition.source.url,
    name: definition.name,
    description: definition.summary,
    auth,
    connection: input.connection,
    requiredScopes: [...definition.authentication.scopes],
    authScheme: {
      kind: definition.authentication.kind,
      placement: definition.authentication.tokenPlacement,
    },
  });
}

async function resolveOpenApi(
  input: Parameters<typeof resolveApiIntegrationPreview>[0],
  sourceUrl: string,
  baseUrl?: string,
): Promise<ResolvedApiIntegrationPreview> {
  const document = parseOpenApiDocument(
    await fetchIntegrationSourceDocument(input.transport, sourceUrl),
  );
  const identity = integrationInstallationIdentity(
    "openapi",
    new URL(sourceUrl).hostname,
    sourceUrl,
  );
  const revision = compileOpenApiRevision(document, {
    definitionId: identity.sourceDerivedDefinitionId,
    sourceUrl,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const resolvedBaseUrl = firstOpenApiServerUrl(revision);
  const providerDomain = new URL(resolvedBaseUrl).hostname.toLowerCase();
  const discovered = discoverOpenApiAuth(document);
  const auth = authPreview(discovered, providerDomain, input.connection);
  return resolvedPreview({
    source: input.source,
    definitionId: identity.sourceDerivedDefinitionId,
    definitionProvenance: "workspace",
    identity,
    revision,
    provider: null,
    providerDomain,
    baseUrl: resolvedBaseUrl,
    sourceUrl,
    name: revision.title,
    description: revision.description ?? null,
    auth,
    connection: input.connection,
    requiredScopes: auth.kind === "oauth2" ? auth.scopes : [],
    authScheme: discovered,
  });
}

async function resolveGraphql(
  input: Parameters<typeof resolveApiIntegrationPreview>[0],
  endpoint: string,
  name?: string,
): Promise<ResolvedApiIntegrationPreview> {
  const providerDomain = new URL(endpoint).hostname.toLowerCase();
  const identity = integrationInstallationIdentity("graphql", providerDomain, endpoint);
  const introspection = await fetchGraphqlIntrospection({
    endpoint,
    transport: input.transport,
    authority: input.authority,
    ...(input.credentialResolver ? { credentialResolver: input.credentialResolver } : {}),
  });
  const revision = compileGraphqlRevision(introspection, {
    definitionId: identity.sourceDerivedDefinitionId,
    endpoint,
    sourceUrl: endpoint,
    ...(name ? { name } : {}),
  });
  const auth = input.connection
    ? connectionAuthPreview(input.connection, providerDomain)
    : ({ kind: "none" } as const);
  return resolvedPreview({
    source: input.source,
    definitionId: identity.sourceDerivedDefinitionId,
    definitionProvenance: "workspace",
    identity,
    revision,
    provider: null,
    providerDomain,
    baseUrl: endpoint,
    sourceUrl: endpoint,
    name: revision.title,
    description: revision.description ?? null,
    auth,
    connection: input.connection,
    requiredScopes: input.connection?.scopes ?? [],
    authScheme: auth,
  });
}

function resolvedPreview(input: {
  source: IntegrationSource;
  definitionId: string;
  definitionProvenance: "curated" | "workspace";
  identity: ReturnType<typeof integrationInstallationIdentity>;
  revision: StoredApiIntegrationRevision;
  provider: string | null;
  providerDomain: string;
  baseUrl: string;
  sourceUrl: string;
  name: string;
  description: string | null;
  auth: ApiIntegrationAuthPreview;
  connection: ApiIntegrationConnectionDescriptor | null;
  requiredScopes: string[];
  authScheme: Record<string, unknown>;
}): ResolvedApiIntegrationPreview {
  const deprecated = input.revision.tools.filter((tool) => tool.deprecated).length;
  const warnings = [
    ...(deprecated > 0
      ? [`${deprecated} deprecated operation${deprecated === 1 ? "" : "s"} will not be enabled.`]
      : []),
    ...(input.revision.tools.length > 500
      ? ["This Integration has many tools; schemas stay behind lazy tool discovery."]
      : []),
  ];
  return {
    preview: ApiIntegrationPreview.parse({
      source: input.source,
      definitionId: input.definitionId,
      definitionProvenance: input.definitionProvenance,
      protocol: input.revision.protocol,
      capabilityId: input.identity.capabilityId,
      pluginKey: input.identity.pluginKey,
      serverId: input.identity.serverId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      providerDomain: input.providerDomain,
      baseUrl: input.baseUrl,
      sourceUrl: input.sourceUrl,
      revisionId: input.revision.id,
      contentSha256: input.revision.contentSha256,
      auth: input.auth,
      connectionId: input.connection?.id ?? null,
      connectionOwnership: input.connection?.ownership ?? null,
      tools: input.revision.tools.map((tool) => ({
        id: tool.id,
        operationKey: tool.operationKey,
        name: tool.name,
        description: tool.description,
        safety: tool.safety,
        approvalMode: tool.approvalMode,
        deprecated: tool.deprecated,
      })),
      warnings,
    }),
    revision: input.revision,
    provider: input.provider,
    requiredScopes: [...new Set(input.requiredScopes)].sort(),
    authScheme: input.authScheme,
  };
}

function integrationInstallationIdentity(
  protocol: "openapi" | "graphql",
  label: string,
  locator: string,
) {
  const hash = createHash("sha256").update(`${protocol}\0${locator}`).digest("hex").slice(0, 12);
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "integration";
  return {
    sourceDerivedDefinitionId: `${slug}-${hash}`,
    pluginKey: `integration/${protocol}/${slug}-${hash}`,
    capabilityId: `api:${protocol}:${slug}-${hash}`,
    serverId: `api_${protocol}_${slug.replaceAll("-", "_").slice(0, 48)}_${hash}`,
  };
}

function firstOpenApiServerUrl(revision: {
  bindings: Readonly<Record<string, { serverUrl: string }>>;
}): string {
  const first = Object.values(revision.bindings)[0]?.serverUrl;
  if (!first) throw new Error("OpenAPI revision has no executable server URL");
  return first;
}

function authPreview(
  discovered: OpenApiAuthDiscovery,
  providerDomain: string,
  connection: ApiIntegrationConnectionDescriptor | null,
): ApiIntegrationAuthPreview {
  if (connection) {
    assertConnectionMatchesAuth(connection, providerDomain, discovered.kind);
  }
  if (discovered.kind === "none") return discovered;
  if (discovered.kind === "oauth2") {
    return { kind: "oauth2", providerDomain, scopes: discovered.scopes };
  }
  if (discovered.kind === "api_key") {
    return {
      kind: "api_key",
      providerDomain,
      carrier: discovered.carrier,
      name: discovered.name,
    };
  }
  return { kind: "http", providerDomain, scheme: discovered.scheme };
}

function connectionAuthPreview(
  connection: ApiIntegrationConnectionDescriptor,
  providerDomain: string,
): ApiIntegrationAuthPreview {
  assertConnectionMatchesAuth(connection, providerDomain);
  if (connection.kind === "oauth2") {
    return { kind: "oauth2", providerDomain, scopes: [...connection.scopes] };
  }
  return {
    kind: "api_key",
    providerDomain,
    carrier: "header",
    name: "Authorization",
  };
}

function assertConnectionMatchesAuth(
  connection: ApiIntegrationConnectionDescriptor,
  providerDomain: string,
  discoveredKind?: OpenApiAuthDiscovery["kind"],
): void {
  if (connection.providerDomain.toLowerCase() !== providerDomain) {
    throw new Error("Selected Connection does not match the Integration provider");
  }
  if (discoveredKind === "oauth2" && connection.kind !== "oauth2") {
    throw new Error("This Integration requires an OAuth Connection");
  }
  if (
    discoveredKind !== undefined &&
    discoveredKind !== "none" &&
    discoveredKind !== "oauth2" &&
    connection.kind === "oauth2"
  ) {
    throw new Error("This Integration requires a credential Connection, not OAuth");
  }
}
