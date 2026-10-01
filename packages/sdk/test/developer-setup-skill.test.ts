import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CreateConnectionRequest,
  CreateOrganizationApiKeyRequest,
  CreateSessionRequest,
  EnsureWorkspaceRequest,
  InstallApiIntegrationRequest,
  PreviewApiIntegrationRequest,
  UpdateSessionMcpApprovalPolicyRequest,
  UpdateWorkspaceSettingsRequest,
  CreateScheduledTaskRequest,
  CreateAutomationSourceRequest,
  CreateAutomationTriggerRequest,
  CreateWorkspaceWebhookRequest,
  PutWorkspaceCredentialProviderRequest,
} from "@opengeni/contracts";
import { AddExternalWorkspaceMemberRequest } from "@opengeni/contracts/external-identities";
import { SetWorkspaceAllowanceRequest } from "@opengeni/contracts/usage-allowances";
import * as sdkExamples from "../../../.agents/skills/opengeni-setup/references/setup-sdk";

const referencePath = `${import.meta.dir}/../../../.agents/skills/opengeni-setup/references/setup-api.md`;

function expectPreservedRequest(
  contract: { parse(input: unknown): unknown },
  request: Record<string, unknown>,
): void {
  // A successful Zod parse alone can silently strip an invented field. Every
  // documented field must survive parsing, including fields in nested objects.
  expect(contract.parse(request)).toMatchObject(request);
}

describe("developer setup skill", () => {
  test("all illustrative JSON request bodies match their exact public contracts", async () => {
    const markdown = await readFile(referencePath, "utf8");
    const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(examples).toHaveLength(16);
    // Never permit arbitrary organization-key permissions. Tokens and remote
    // ids below are fake fixtures; the key request uses the actual public schema.
    expect(examples[0]).toEqual({ name: "Product developer setup", access: "developer_setup" });
    expectPreservedRequest(CreateOrganizationApiKeyRequest, examples[0]);
    expectPreservedRequest(EnsureWorkspaceRequest, examples[1]);
    expectPreservedRequest(UpdateWorkspaceSettingsRequest, examples[2]);
    expectPreservedRequest(AddExternalWorkspaceMemberRequest, examples[3]);
    expectPreservedRequest(CreateConnectionRequest, examples[4]);
    expectPreservedRequest(PreviewApiIntegrationRequest, examples[5]);
    expectPreservedRequest(InstallApiIntegrationRequest, {
      ...examples[6],
      expectedContentSha256: "a".repeat(64),
    });
    // A fragment intentionally containing only MCP fields is a partial session.
    expectPreservedRequest(CreateSessionRequest, {
      initialMessage: "Safe tool check",
      ...examples[7],
    });
    expectPreservedRequest(UpdateSessionMcpApprovalPolicyRequest, examples[8]);
    expectPreservedRequest(CreateScheduledTaskRequest, examples[9]);
    expectPreservedRequest(CreateAutomationSourceRequest, {
      ...examples[10],
      webhookSecret: "fixture-secret-123",
    });
    expectPreservedRequest(CreateAutomationTriggerRequest, examples[11]);
    expectPreservedRequest(CreateWorkspaceWebhookRequest, examples[12]);
    expectPreservedRequest(PutWorkspaceCredentialProviderRequest, examples[13]);
    expectPreservedRequest(SetWorkspaceAllowanceRequest, examples[14]);
    expectPreservedRequest(CreateSessionRequest, examples[15]);
  });

  test("SDK examples remain callable and typechecked with the actual SDK", () => {
    expect(sdkExamples.productAgent.capabilities).toBe("none");
    for (const example of [
      sdkExamples.serverClient,
      sdkExamples.createSetupKey,
      sdkExamples.ensureProductWorkspace,
      sdkExamples.configureAgent,
      sdkExamples.admitProductUser,
      sdkExamples.createProductConnection,
      sdkExamples.installProductApi,
      sdkExamples.setMcpApproval,
      sdkExamples.configureSchedule,
      sdkExamples.configureEventSource,
      sdkExamples.configureWebhook,
      sdkExamples.configureCredentialProvider,
      sdkExamples.configureBudget,
      sdkExamples.createSmokeSession,
      sdkExamples.removeDisposableIntegration,
    ]) {
      expect(typeof example).toBe("function");
    }
  });
});
