import { describe, expect, test } from "bun:test";
import type {
  McpConnectionResourceScope,
  McpCredentialResolution,
  McpCredentialsRequest,
  McpServerConnectionRef,
} from "@opengeni/contracts";
import { buildHostConnectionTokenResolver } from "../src";

type Binding = McpServerConnectionRef & {
  connectionId: string;
  provider: string;
  selectedResources: McpConnectionResourceScope[];
};

const BINDINGS: Binding[] = [
  {
    connectionId: "github-installation-a",
    provider: "github",
    providerDomain: "github.com",
    kind: "app_install",
    selectedResources: [
      { kind: "repository", id: "101" },
      { kind: "repository", id: "102" },
    ],
  },
  {
    connectionId: "github-installation-b",
    provider: "github",
    providerDomain: "github.com",
    kind: "app_install",
    selectedResources: [{ kind: "repository", id: "201" }],
  },
  {
    connectionId: "gitlab-account-a",
    provider: "gitlab",
    providerDomain: "gitlab.example",
    kind: "delegated",
    selectedResources: [{ kind: "repository", id: "301" }],
  },
  {
    connectionId: "azure-organization-a",
    provider: "azure_devops",
    providerDomain: "dev.azure.com",
    kind: "delegated",
    selectedResources: [{ kind: "repository", id: "00000000-0000-4000-8000-000000000401" }],
  },
];

function resourceKeys(resources: McpConnectionResourceScope[] | undefined): string[] {
  return (resources ?? []).map((resource) => `${resource.kind}:${resource.id}`).sort();
}

describe("provider-neutral host DevOps MCP conformance", () => {
  test("routes two same-provider bindings plus GitLab and Azure across model and Toolspace", async () => {
    const allowed = new Map(BINDINGS.map((binding) => [binding.connectionId, binding]));
    const calls: McpCredentialsRequest[] = [];
    const hostResolve = async (
      request: McpCredentialsRequest,
    ): Promise<McpCredentialResolution> => {
      calls.push(request);
      const requested = request.connectionRef;
      const binding = requested.connectionId ? allowed.get(requested.connectionId) : undefined;
      const echo = {
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        providerDomain: requested.providerDomain,
        ...(requested.provider ? { provider: requested.provider } : {}),
        ...(requested.connectionId ? { connectionId: requested.connectionId } : {}),
        ...(requested.selectedResources
          ? { selectedResources: requested.selectedResources.map((resource) => ({ ...resource })) }
          : {}),
      };
      if (!binding) {
        return {
          status: "auth_needed" as const,
          ...echo,
          reason: "unsupported_auth" as const,
        };
      }
      if (
        binding.provider !== requested.provider ||
        binding.providerDomain !== requested.providerDomain ||
        resourceKeys(binding.selectedResources).join("\0") !==
          resourceKeys(requested.selectedResources).join("\0")
      ) {
        return {
          status: "auth_needed" as const,
          ...echo,
          reason: "resource_scope_unavailable" as const,
        };
      }
      return {
        status: "ok" as const,
        ...echo,
        connectionId: binding.connectionId,
        headers: {
          Authorization: `Bearer ${binding.connectionId}:${request.surface}:${request.forceRefresh}`,
        },
      };
    };

    for (const [surface, forceRefresh] of [
      ["model", false],
      ["toolspace", true],
    ] as const) {
      const resolver = buildHostConnectionTokenResolver(hostResolve, {
        accountId: "account-one",
        workspaceId: "workspace-one",
        sessionId: "session-one",
        rootSessionId: "session-root",
        turnId: "turn-one",
        attemptId: surface === "model" ? "attempt-one" : null,
        executionGeneration: 7,
        initiator: { kind: "subject", subjectId: "host:user:one" },
        initiatorContext: { source: "host" },
        surface,
      });
      for (const binding of BINDINGS) {
        const result = await resolver({
          workspaceId: "workspace-one",
          serverId: `${binding.provider}-${binding.connectionId}`,
          connectionRef: binding,
          forceRefresh,
        });
        expect(result).toMatchObject({
          status: "ok",
          connectionId: binding.connectionId,
          headers: {
            Authorization: `Bearer ${binding.connectionId}:${surface}:${forceRefresh}`,
          },
        });
      }
    }

    expect(calls).toHaveLength(8);
    expect(new Set(calls.map((request) => request.connectionRef.connectionId))).toEqual(
      new Set(BINDINGS.map((binding) => binding.connectionId)),
    );
    expect(calls.map((request) => request.rootSessionId)).toEqual(
      Array.from({ length: 8 }, () => "session-root"),
    );
    expect(calls.every((request) => request.initiator.subjectId === "host:user:one")).toBe(true);
  });

  test("refuses incompatible auth and widened repository scope without affecting other bindings", async () => {
    const compatible = BINDINGS[0]!;
    const resolver = buildHostConnectionTokenResolver(
      async (request): Promise<McpCredentialResolution> => {
        const echo = {
          accountId: request.accountId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          providerDomain: request.connectionRef.providerDomain,
          ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
          ...(request.connectionRef.connectionId
            ? { connectionId: request.connectionRef.connectionId }
            : {}),
          ...(request.connectionRef.selectedResources
            ? { selectedResources: request.connectionRef.selectedResources }
            : {}),
        };
        if (request.connectionRef.connectionId === compatible.connectionId) {
          return {
            status: "ok" as const,
            ...echo,
            connectionId: compatible.connectionId,
            headers: { Authorization: "Bearer compatible" },
          };
        }
        return {
          status: "auth_needed" as const,
          ...echo,
          reason:
            request.connectionRef.connectionId === "gitlab-hosted-oauth-only"
              ? ("unsupported_auth" as const)
              : ("resource_scope_unavailable" as const),
        };
      },
      {
        accountId: "account-one",
        workspaceId: "workspace-one",
        sessionId: "session-one",
        rootSessionId: "session-root",
        turnId: "turn-one",
        attemptId: "attempt-one",
        executionGeneration: 7,
        initiator: { kind: "subject", subjectId: "host:user:one" },
        initiatorContext: { source: "host" },
        surface: "model",
      },
    );

    const unavailable = await resolver({
      workspaceId: "workspace-one",
      serverId: "gitlab-hosted",
      connectionRef: {
        connectionId: "gitlab-hosted-oauth-only",
        provider: "gitlab",
        providerDomain: "gitlab.com",
        kind: "oauth2",
        selectedResources: [{ kind: "repository", id: "501" }],
      },
    });
    expect(unavailable).toMatchObject({ status: "auth_needed", reason: "unsupported_auth" });

    const widened = await resolver({
      workspaceId: "workspace-one",
      serverId: "github-widened",
      connectionRef: {
        connectionId: "github-widened",
        provider: "github",
        providerDomain: "github.com",
        kind: "app_install",
        selectedResources: [
          ...compatible.selectedResources,
          { kind: "repository", id: "not-selected" },
        ],
      },
    });
    expect(widened).toMatchObject({
      status: "auth_needed",
      reason: "resource_scope_unavailable",
    });

    const stillCompatible = await resolver({
      workspaceId: "workspace-one",
      serverId: "github-compatible",
      connectionRef: compatible,
    });
    expect(stillCompatible).toMatchObject({ status: "ok", connectionId: compatible.connectionId });
  });
});
