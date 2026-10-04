// Server-only examples. Import these functions into the product's provisioning
// script after its normal .env loader. Never log a client, request credentials,
// key-creation response, webhook response or provider response.
import type {
  AgentConfigRequest,
  CreateConnectionRequest,
  CreateSessionRequest,
  EnsureWorkspaceRequest,
  InstallApiIntegrationRequest,
  PreviewApiIntegrationRequest,
} from "@opengeni/sdk";
import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniAutomationsClient } from "@opengeni/sdk/automations";
import {
  getWorkspaceAllowance,
  getWorkspaceAllowanceState,
  getUsage,
  setWorkspaceAllowance,
} from "@opengeni/sdk/usage-allowances";
import {
  getWorkspaceWebhook,
  testWorkspaceCredentialProvider,
  testWorkspaceWebhook,
} from "@opengeni/sdk/workspace-integrations";

export const productAgent: AgentConfigRequest = {
  identity: "You are Acme's product assistant. Be brief and factual.",
  capabilities: "none",
  renderer: "opengeni",
};

export function serverClient(env: Record<string, string | undefined>) {
  if (!env.OPENGENI_API_BASE_URL || !env.OPENGENI_API_KEY) {
    throw new Error("Set server-only OPENGENI_API_BASE_URL and OPENGENI_API_KEY");
  }
  return new OpenGeniClient({
    baseUrl: env.OPENGENI_API_BASE_URL,
    apiKey: env.OPENGENI_API_KEY,
  });
}

// Authenticate as an organization administrator for key creation, not as the
// setup key. Capture { token, apiKey.id } directly to the secure store/ledger.
export async function createSetupKey(admin: OpenGeniClient, organizationId: string) {
  return await admin.createOrganizationApiKey(organizationId, {
    name: "Product setup",
    access: "full",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

export async function ensureProductWorkspace(
  og: OpenGeniClient,
  organizationId: string,
  mapping: EnsureWorkspaceRequest,
) {
  const access = await og.getAccessContext();
  if (
    access.credential?.kind !== "organization_api_key" ||
    access.credential.accountId !== organizationId
  ) {
    throw new Error("Expected this organization's setup key");
  }
  const result = await og.ensureWorkspace({ ...mapping, accountId: organizationId });
  const workspace = await og.getWorkspace(result.workspace.id);
  if (
    workspace.kind !== "shared" ||
    workspace.accountId !== organizationId ||
    workspace.externalSource !== mapping.externalSource ||
    workspace.externalId !== mapping.externalId
  ) {
    throw new Error("Workspace mapping verification failed");
  }
  const config = await og.getClientConfig({ workspaceId: workspace.id });
  return { workspace, created: result.created, config };
}

export async function configureAgent(og: OpenGeniClient, workspaceId: string) {
  const config = await og.getClientConfig({ workspaceId });
  if (config.agentConfig?.enabled !== true) return { configured: false as const };
  const before = await og.getWorkspace(workspaceId);
  // Read/merge desired settings in a real migration; don't write on every chat.
  if (JSON.stringify(before.settings.sessionAgentDefaults) !== JSON.stringify(productAgent)) {
    await og.updateWorkspaceSettings(workspaceId, { sessionAgentDefaults: productAgent });
  }
  const verified = await og.getWorkspace(workspaceId);
  return { configured: true as const, defaults: verified.settings.sessionAgentDefaults };
}

export async function admitProductUser(
  og: OpenGeniClient,
  workspaceId: string,
  externalId: string,
  operationId: string, // Persist UUID before the request; reuse with exact input.
) {
  await og.addExternalWorkspaceMember(workspaceId, {
    identity: { source: "acme-product", externalId },
    operationId,
    permissions: [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "files:upload",
      "files:read",
      "mcp_servers:attach",
    ],
  });
  return await og.listWorkspaceMembers(workspaceId);
}

export async function createProductConnection(
  og: OpenGeniClient,
  workspaceId: string,
  request: CreateConnectionRequest, // Write-only credentials; never log.
) {
  const connection = await og.createConnection(workspaceId, request);
  const verified = (await og.listConnections(workspaceId)).find(
    (candidate) => candidate.id === connection.id,
  );
  if (!verified) throw new Error("Connection inventory verification failed");
  return verified;
}

export async function installProductApi(
  og: OpenGeniClient,
  workspaceId: string,
  request: PreviewApiIntegrationRequest,
  selectedToolIds: string[], // From preview; product policy, not guessed ids.
  autoApprovedToolIds: string[] = [],
) {
  const preview = await og.previewApiIntegration(workspaceId, request);
  if (selectedToolIds.some((id) => !preview.tools.some((tool) => tool.id === id))) {
    throw new Error("Selected tool is not in the exact API preview");
  }
  const existing = (await og.listApiIntegrations(workspaceId)).integrations.find(
    (integration) => integration.instanceKey === "acme-product",
  );
  // Skip an unchanged desired state. For an update, compare the read policy and
  // use its exact version; never overwrite a conflicting installation blindly.
  const install: InstallApiIntegrationRequest = {
    ...request,
    expectedRevisionId: preview.revisionId,
    expectedContentSha256: preview.contentSha256,
    instanceKey: "acme-product",
    displayName: "Acme product",
    allowedTools: selectedToolIds,
    autoApprovedTools: autoApprovedToolIds,
    ...(existing ? { expectedInstanceVersion: existing.instanceVersion } : {}),
  };
  const installed = await og.installApiIntegration(workspaceId, install);
  const verified = (await og.listApiIntegrations(workspaceId)).integrations.find(
    (integration) => integration.instanceId === installed.instanceId,
  );
  if (!verified) throw new Error("Integration inventory verification failed");
  return verified;
}

export async function setMcpApproval(
  og: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  serverId: string,
) {
  await og.updateSessionMcpApprovalPolicy(workspaceId, sessionId, serverId, {
    requireApproval: true,
  });
  return await og.getSession(workspaceId, sessionId);
}

export async function configureSchedule(
  og: OpenGeniClient,
  workspaceId: string,
  serverId: string,
  timeZone: string,
) {
  const config = await og.getClientConfig({ workspaceId });
  if (!config.agentConfig?.enabled) {
    throw new Error(
      "Minimal scheduled agents need agent configuration admission on this deployment",
    );
  }
  const setupKey = "acme-product:morning-summary";
  const matches = (await og.listScheduledTasks(workspaceId)).filter(
    (task) => task.metadata.developerSetupKey === setupKey,
  );
  if (matches.length > 1) throw new Error("Duplicate provisioning key; reconcile schedules");
  const task =
    matches[0] ??
    (await og.createScheduledTask(workspaceId, {
      name: "Acme morning summary",
      schedule: { type: "calendar", hour: 8, minute: 0, timeZone },
      status: "paused",
      agentConfig: {
        prompt: "Summarize the latest report using Acme's tools.",
        agent: productAgent,
        sandboxBackend: "none",
        tools: [{ kind: "mcp", id: serverId }],
      },
      metadata: { developerSetupKey: setupKey },
    }));
  return await og.getScheduledTask(workspaceId, task.id);
}

export async function configureEventSource(
  og: OpenGeniClient,
  workspaceId: string,
  webhookSecret: string,
) {
  const automations = new OpenGeniAutomationsClient(og);
  const matches = (await automations.listSources(workspaceId)).filter(
    (source) => source.name === "Acme product events",
  );
  if (matches.length > 1) throw new Error("Reconcile duplicate event sources");
  const source =
    matches[0] ??
    (await automations.createSource(workspaceId, {
      name: "Acme product events",
      adapterId: "signed-json.v1",
      webhookSecret,
      configuration: {},
    }));
  return (await automations.listSources(workspaceId)).find((item) => item.id === source.id);
}

export async function configureWebhook(
  og: OpenGeniClient,
  workspaceId: string,
  url: string,
  storeSecret: (name: string, value: string) => Promise<void>,
) {
  const matches = (await og.listWorkspaceWebhooks(workspaceId)).webhooks.filter(
    (webhook) => webhook.description === "acme-product developer setup",
  );
  if (matches.length > 1) throw new Error("Reconcile duplicate workspace webhooks");
  let webhook = matches[0];
  if (!webhook) {
    const created = await og.createWorkspaceWebhook(workspaceId, {
      url,
      eventTypes: ["turn.completed", "session.requiresAction"],
      enabled: true,
      description: "acme-product developer setup",
    });
    await storeSecret("OPENGENI_WEBHOOK_SECRET", created.secret);
    webhook = created.webhook;
  }
  const verified = await getWorkspaceWebhook(og, workspaceId, webhook.id);
  if (verified.url !== url) throw new Error("Existing webhook URL differs; reconcile first");
  await testWorkspaceWebhook(og, workspaceId, webhook.id);
  // Receiver must also verify raw-body signature; don't call this alone a pass.
  return await og.listWorkspaceWebhookDeliveries(workspaceId, webhook.id);
}

export async function configureCredentialProvider(
  og: OpenGeniClient,
  workspaceId: string,
  url: string,
  storeSecret: (name: string, value: string) => Promise<void>,
) {
  const current = await og.getWorkspaceCredentialProvider(workspaceId);
  if (current.provider && current.provider.url !== url) {
    throw new Error("Existing credential provider URL differs; reconcile first");
  }
  const result = await og.putWorkspaceCredentialProvider(workspaceId, {
    url,
    enabled: true,
    timeoutMs: 10000,
  });
  if (result.secret) await storeSecret("OPENGENI_CREDENTIAL_PROVIDER_SECRET", result.secret);
  const verified = await og.getWorkspaceCredentialProvider(workspaceId);
  const test = await testWorkspaceCredentialProvider(og, workspaceId);
  return { provider: verified.provider, test }; // Test returns secret-safe metadata.
}

export async function configureBudget(
  og: OpenGeniClient,
  workspaceId: string,
  includedCredits: number, // Requested ceiling in integer USD micros, not a purchase.
) {
  const state = await getWorkspaceAllowanceState(og, workspaceId);
  if (state.config?.includedCredits !== includedCredits || state.config.period !== "monthly") {
    await setWorkspaceAllowance(og, workspaceId, {
      expectedVersion: state.version,
      includedCredits,
      period: "monthly",
      anchorDay: 1,
      memberDefault: "none",
      thresholds: { workspace: [0.8, 1] },
    });
  }
  return {
    allowance: await getWorkspaceAllowance(og, workspaceId),
    usage: await getUsage(og, workspaceId),
  };
}

export async function createSmokeSession(
  og: OpenGeniClient,
  workspaceId: string,
  idempotencyKey: string, // Saved before request, reused on ambiguous retries.
  tools: CreateSessionRequest["tools"] = [],
) {
  const config = await og.getClientConfig({ workspaceId });
  const session = await og.createSession(workspaceId, {
    initialMessage: "Reply SETUP_OK, then use the selected product read tool if available.",
    idempotencyKey,
    sandboxBackend: "none",
    tools,
    bundledSkillIds: [],
    ...(config.agentConfig?.enabled
      ? { agent: productAgent }
      : { instructions: productAgent.identity!, firstPartyMcpTools: [] }),
  });
  return {
    session: await og.getSession(workspaceId, session.id),
    events: await og.listEvents(workspaceId, session.id),
  }; // Poll/stream until an actual answer or actionable refusal before declaring success.
}

export async function removeDisposableIntegration(
  og: OpenGeniClient,
  workspaceId: string,
  capabilityId: string,
  instanceKey: string,
) {
  const preview = await og.previewApiIntegrationUninstall(workspaceId, capabilityId, instanceKey);
  if (!preview.installed) return;
  if (!preview.installationVersion || !preview.instanceVersion) {
    throw new Error("Missing uninstall versions; reread, never guess");
  }
  await og.uninstallApiIntegration(workspaceId, capabilityId, instanceKey, {
    expectedInstallationVersion: preview.installationVersion,
    expectedInstanceVersion: preview.instanceVersion,
  });
  return await og.listApiIntegrations(workspaceId);
}
