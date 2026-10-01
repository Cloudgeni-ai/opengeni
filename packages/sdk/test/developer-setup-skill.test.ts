import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CreateConnectionRequest,
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

describe("developer setup skill", () => {
  test("all illustrative JSON request bodies match their exact public contracts", async () => {
    const markdown = await readFile(referencePath, "utf8");
    const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(examples).toHaveLength(16);
    // The scoped key contract is checked by preset tests; never permit arbitrary
    // organization-key permissions. Tokens and remote ids below are fake fixtures.
    expect(examples[0]).toEqual({ name: "Product developer setup", access: "developer_setup" });
    EnsureWorkspaceRequest.parse(examples[1]);
    UpdateWorkspaceSettingsRequest.parse(examples[2]);
    AddExternalWorkspaceMemberRequest.parse(examples[3]);
    CreateConnectionRequest.parse(examples[4]);
    PreviewApiIntegrationRequest.parse(examples[5]);
    InstallApiIntegrationRequest.parse({
      ...examples[6],
      expectedContentSha256: "a".repeat(64),
    });
    // A fragment intentionally containing only MCP fields is a partial session.
    CreateSessionRequest.parse({ initialMessage: "Safe tool check", ...examples[7] });
    UpdateSessionMcpApprovalPolicyRequest.parse(examples[8]);
    CreateScheduledTaskRequest.parse(examples[9]);
    CreateAutomationSourceRequest.parse({ ...examples[10], webhookSecret: "fixture-secret-123" });
    CreateAutomationTriggerRequest.parse(examples[11]);
    CreateWorkspaceWebhookRequest.parse(examples[12]);
    PutWorkspaceCredentialProviderRequest.parse(examples[13]);
    SetWorkspaceAllowanceRequest.parse(examples[14]);
    CreateSessionRequest.parse(examples[15]);
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
