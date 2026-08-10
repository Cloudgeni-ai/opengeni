import type { FetchLike, OutboundNetworkSettings } from "@opengeni/network";

export type IntegrationProtocol = "mcp" | "openapi" | "graphql";
export type IntegrationToolSafety = "read" | "write" | "destructive";
export type IntegrationApprovalMode = "never" | "ask";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface IntegrationToolDefinition {
  readonly id: string;
  readonly operationKey: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly safety: IntegrationToolSafety;
  readonly approvalMode: IntegrationApprovalMode;
  readonly deprecated: boolean;
}

export type CredentialCarrier = "header" | "query" | "cookie";

export interface IntegrationCredentialPlacement {
  readonly carrier: CredentialCarrier;
  readonly name: string;
  readonly value: string;
  readonly prefix?: string;
}

export interface IntegrationCredentialAudience {
  /** Exact normalized origin the credential may reach. */
  readonly origin: string;
  /** Optional normalized path prefix. Defaults to `/`. */
  readonly pathPrefix?: string;
}

export interface ResolvedIntegrationCredential {
  readonly audience: IntegrationCredentialAudience;
  readonly placements: readonly IntegrationCredentialPlacement[];
  readonly expiresAt?: string;
  readonly scope?: readonly string[];
}

export interface IntegrationInvocationAuthority {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly rootSessionId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly initiatingSubjectId?: string;
  readonly connectionRef?: string;
}

export interface ResolveIntegrationCredentialRequest extends IntegrationInvocationAuthority {
  readonly protocol: Exclude<IntegrationProtocol, "mcp">;
  readonly integrationId: string;
  readonly revisionId: string;
  readonly operationKey: string;
  readonly destinationUrl: string;
  readonly requiredScopeAlternatives?: readonly (readonly string[])[];
  /** Refresh the exact bound Connection for a safe retry or a later call. */
  readonly forceRefresh?: boolean;
}

export interface IntegrationCredentialResolver {
  resolve(
    request: ResolveIntegrationCredentialRequest,
  ): Promise<ResolvedIntegrationCredential | null>;
}

export interface IntegrationTransport {
  readonly fetch: FetchLike;
}

export interface PinnedIntegrationTransportOptions {
  readonly network: OutboundNetworkSettings;
  readonly fetchImpl?: FetchLike;
}

export type IntegrationRevisionSource = {
  readonly url?: string;
  readonly provider?: string;
  readonly fetchedAt?: string;
};

export interface IntegrationRevision<
  TBinding = unknown,
  TProtocol extends Exclude<IntegrationProtocol, "mcp"> = Exclude<IntegrationProtocol, "mcp">,
> {
  readonly id: string;
  readonly protocol: TProtocol;
  readonly integrationId: string;
  readonly contentSha256: string;
  readonly source: IntegrationRevisionSource;
  readonly title: string;
  readonly description?: string;
  readonly version?: string;
  readonly tools: readonly IntegrationToolDefinition[];
  readonly bindings: Readonly<Record<string, TBinding>>;
}

export type InvocationOutcome = "not_started" | "unknown" | "failed";

export class IntegrationProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationProtocolError";
  }
}

export class IntegrationInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: InvocationOutcome,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntegrationInvocationError";
  }
}
