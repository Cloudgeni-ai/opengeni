import type {
  ClaudeSubscriptionUsage,
  ConnectionMetadata,
  WorkspaceGatewayCustomModel,
} from "@opengeni/sdk";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "../src/components/ui/sonner";
import {
  PROVIDER_CONNECTION_CONFIGS,
  ProviderConnectPage,
  ProviderConnectionPage,
  ProviderConnectionRow,
  useProviderConnection,
  type ProviderConnectionView,
} from "../src/components/ai-gateway-connection";
import { useOrganizationProviderConnection } from "../src/components/organization-model-provider-connection";
import { ACCOUNT_COLUMNS } from "../src/components/models/codex-models";
import { RowList } from "../src/components/ui/list-row";
import { AppearanceProvider } from "../src/lib/appearance";
import "../src/styles.css";

const scopeId = "22222222-2222-4222-8222-222222222222";

function Connection({
  client,
  organization,
  render,
}: {
  client: OpenGeniBrowserClient;
  organization: boolean;
  render(state: ProviderConnectionView): React.ReactNode;
}) {
  const workspace = useProviderConnection({
    client,
    config: PROVIDER_CONNECTION_CONFIGS.claude_subscription,
    workspaceId: scopeId,
    canManageConnection: true,
    canManageCustomModels: true,
    enabled: !organization,
  });
  const org = useOrganizationProviderConnection({
    client,
    organizationId: scopeId,
    providerKind: "claude_subscription",
    enabled: organization,
  });
  return render(organization ? org : workspace);
}

function Fixture() {
  const organization = new URLSearchParams(location.search).get("scope") === "organization";
  const [view, setView] = useState<"connect" | "account" | "list">("connect");
  const [receipt, setReceipt] = useState<Record<string, unknown>>({
    action: "ready",
  });
  const [quotaRequest, setQuotaRequest] = useState<Record<string, unknown> | null>(null);
  const fullSignIn = useRef(false);
  const record = useRef<ConnectionMetadata | null>(null);
  const models = useRef<WorkspaceGatewayCustomModel[]>([]);
  const usage = useRef<ClaudeSubscriptionUsage>({
    connected: false,
    credentialVersion: null,
    windows: [],
    observedAt: null,
    source: null,
    refreshStatus: "not_checked",
    refreshCheckedAt: null,
  });
  const clientRef = useRef<OpenGeniBrowserClient | null>(null);
  if (!clientRef.current) {
    // Exercise the actual SDK serializer; mocked methods previously hid a missing
    // JSON Content-Type that the API's browser mutation guard rejects.
    const quotaClient = new OpenGeniBrowserClient({
      baseUrl: location.origin,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const json = (value: unknown, status = 200) =>
          Response.json(value, {
            status,
            headers: {
              [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
            },
          });
        const base = `/v1/${organization ? "organizations" : "workspaces"}/${scopeId}/model-providers/claude_subscription`;
        const pathname = new URL(request.url).pathname;
        if (request.method === "POST" && request.headers.get("content-type") !== "application/json")
          return json({ error: "JSON browser request required" }, 403);
        if (pathname === `${base}/oauth/start` && request.method === "POST") {
          return json({
            attemptId: scopeId,
            authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture-state",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }
        if (pathname === `${base}/oauth/complete` && request.method === "POST") {
          const body = await request.json();
          if (body.attemptId !== scopeId || body.code !== "fixture-code#fixture-state")
            return json(
              {
                error: {
                  status: 422,
                  code: "validation_error",
                  message: "Copy the full authorization code from the Claude page.",
                  retryable: false,
                  requestId: scopeId,
                },
              },
              422,
            );
          fullSignIn.current = true;
          const saved = await save({
            apiKey: "sk-ant-oat01-browser-full-signin",
          });
          setReceipt({
            action: "oauth_connect",
            scope: organization ? "organization" : "workspace",
            fields: Object.keys(body).sort(),
          });
          return json({ connected: true, credentialVersion: saved.version });
        }
        const path = `${base}/usage`;
        const refresh = request.method === "POST";
        if (
          new URL(request.url).pathname !== `${path}${refresh ? "/refresh" : ""}` ||
          (!refresh && request.method !== "GET")
        ) {
          throw new Error("Unexpected quota request; inference is disabled in this fixture.");
        }
        if (refresh) {
          const contentType = request.headers.get("content-type");
          if (contentType !== "application/json") {
            return json({ error: "JSON browser request required" }, 403);
          }
          const body = await request.json();
          setQuotaRequest({
            path: new URL(request.url).pathname,
            contentType,
            body,
          });
          usage.current.refreshStatus = fullSignIn.current ? "available" : "scope_required";
        }
        return json(structuredClone(usage.current));
      }) as typeof fetch,
    });
    const save = async (request: { apiKey?: string; credential?: { apiKey?: string } }) => {
      const version = (record.current?.version ?? 0) + 1;
      const now = new Date().toISOString();
      record.current = {
        id: crypto.randomUUID(),
        accountId: scopeId,
        workspaceId: scopeId,
        subjectId: null,
        providerDomain: "api.anthropic.com",
        kind: "api_key",
        status: "active",
        version,
        metadata: { credentialRole: "claude_subscription" },
        grantedScopes: [],
        expiresAt: null,
        lastRefreshAt: null,
        lastUsedAt: null,
        lastError: null,
        createdBySubjectId: "user:fixture",
        updatedBySubjectId: "user:fixture",
        createdAt: now,
        updatedAt: now,
      };
      usage.current = {
        connected: true,
        credentialVersion: version,
        windows:
          version > 1
            ? []
            : [
                {
                  id: "five_hour",
                  usedPercent: 100,
                  resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
                  status: "rejected",
                  observedAt: now,
                },
                {
                  id: "seven_day",
                  usedPercent: 50,
                  resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
                  status: "allowed",
                  observedAt: now,
                },
              ],
        observedAt: version > 1 ? null : now,
        source: version > 1 ? null : fullSignIn.current ? "provider" : "response_headers",
        refreshStatus: fullSignIn.current ? "available" : "not_checked",
        refreshCheckedAt: null,
      };
      setReceipt({
        action: version === 1 ? "connect" : "replace",
        scope: organization ? "organization" : "workspace",
        tokenOnly:
          Object.keys(request).every((key) => key !== "claudeIdentity") &&
          !(request.credential?.apiKey ?? request.apiKey ?? "").startsWith("{"),
      });
      return record.current;
    };
    const add = async (request: { upstreamModelId: string; label?: string }) => {
      const now = new Date().toISOString();
      const model = {
        id: crypto.randomUUID(),
        ...request,
        label: request.label ?? null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      models.current = [...models.current, model];
      return model;
    };
    clientRef.current = {
      listConnections: async () => (record.current ? [record.current] : []),
      createConnection: async (_scope: string, request: any) => save(request),
      updateConnection: async (_scope: string, _id: string, request: any) => {
        fullSignIn.current = false;
        return save(request);
      },
      listWorkspaceClaudeCustomModels: async () => ({ models: models.current }),
      createWorkspaceClaudeCustomModel: async (_scope: string, _kind: string, request: any) =>
        add(request),
      getWorkspaceClaudeSubscriptionUsage:
        quotaClient.getWorkspaceClaudeSubscriptionUsage.bind(quotaClient),
      refreshWorkspaceClaudeSubscriptionUsage:
        quotaClient.refreshWorkspaceClaudeSubscriptionUsage.bind(quotaClient),
      startWorkspaceClaudeSubscriptionOAuth:
        quotaClient.startWorkspaceClaudeSubscriptionOAuth.bind(quotaClient),
      completeWorkspaceClaudeSubscriptionOAuth:
        quotaClient.completeWorkspaceClaudeSubscriptionOAuth.bind(quotaClient),
      getOrganizationModelProviderConnection: async () => record.current,
      upsertOrganizationModelProviderConnection: async (
        _scope: string,
        _kind: string,
        request: any,
      ) => {
        fullSignIn.current = false;
        return save(request);
      },
      listOrganizationProviderCustomModels: async () => ({
        models: models.current,
      }),
      createOrganizationProviderCustomModel: async (_scope: string, _kind: string, request: any) =>
        add(request),
      getOrganizationClaudeSubscriptionUsage:
        quotaClient.getOrganizationClaudeSubscriptionUsage.bind(quotaClient),
      refreshOrganizationClaudeSubscriptionUsage:
        quotaClient.refreshOrganizationClaudeSubscriptionUsage.bind(quotaClient),
      startOrganizationClaudeSubscriptionOAuth:
        quotaClient.startOrganizationClaudeSubscriptionOAuth.bind(quotaClient),
      completeOrganizationClaudeSubscriptionOAuth:
        quotaClient.completeOrganizationClaudeSubscriptionOAuth.bind(quotaClient),
    } as unknown as OpenGeniBrowserClient;
  }
  return (
    <main className="mx-auto min-h-screen max-w-5xl bg-bg p-6 text-fg">
      <Connection
        client={clientRef.current}
        organization={organization}
        render={(state) =>
          view === "connect" ? (
            <ProviderConnectPage
              state={state}
              onClose={() => setView("list")}
              onConnected={() => setView("account")}
            />
          ) : view === "account" ? (
            <ProviderConnectionPage
              state={state}
              scopeName="Fixture workspace"
              onBack={() => setView("list")}
              onConnect={() => setView("connect")}
            />
          ) : (
            <RowList label="Accounts" columns={ACCOUNT_COLUMNS}>
              <ProviderConnectionRow state={state} onOpen={() => setView("account")} />
            </RowList>
          )
        }
      />
      <output data-testid="operation-receipt" className="sr-only">
        {JSON.stringify(receipt)}
      </output>
      <output data-testid="quota-request" className="sr-only">
        {JSON.stringify(quotaRequest)}
      </output>
      <Toaster theme="dark" />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <Fixture />
  </AppearanceProvider>,
);
